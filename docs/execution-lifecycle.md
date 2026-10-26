# 执行身份与生命周期契约

> [← 返回 README](../README.md)

本文说明 La Pluma Next 当前的执行身份、唯一状态来源与生命周期边界，以及必须保留的兼容语义。它面向执行链路、Agent 集成和前端控制器的维护者；不涉及页面视觉。

契约的权威实现是服务端 Run 记录（`server/services/agentRunService.js`）、运行快照（`server/services/runSnapshotService.js`）、执行租约（`server/services/executionCoordinatorService.js`）、作业集会话（`server/services/copilotSetRunService.js`）、任务进程投影（`server/services/maaService.js`）和流程进度投影（`server/services/schedulerService.js`）。文档与代码冲突时，以代码和契约测试为准，并修正本文。

## 1. 执行身份

一次设备执行由服务端 Run 表示，不是 HTTP 请求、页面实例或 MAA 子进程。

| 字段 | 含义 | 约束 |
| --- | --- | --- |
| `runId` | 单次执行的稳定身份 | 服务端生成 UUID；创建后不变 |
| `operationId` | 执行动作类别，如 `run_task`、`run_daily_flow` | 幂等键按它分区 |
| `idempotencyKey` | 调用方提供的逻辑请求键，可空 | 格式 `[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}` |
| `input` / 指纹 | 归一化后的请求输入 | 同键不同输入会被拒绝 |
| `state` | 生命周期状态 | 见第 3 节 |
| `acceptedAt` / `startedAt` / `finishedAt` | 接受、开始、结束时间 | 终态必须有 `finishedAt` |
| `result` / `error` | 终态结果或结构化失败 | `failed`/`interrupted` 必须有 `error` |
| `links.self` / `links.stop` | 按 id 查询与按目标停止入口 | `stop` 为 `/api/agent/actions/stop?runId=…` |
| `recovery` | 重启恢复边界，仅 `interrupted` 存在 | 见 5.7 |
| `progress` | 活动 run 的进度投影 | 读取时计算，不持久化 |

Run 存储是**单实例**语义：默认持久化到 `server/data/agent-runs.json`，可通过 `LA_PLUMA_AGENT_RUN_STORE` 改路径。不要让多个 Node.js 进程同时读写同一文件。终态最多保留 24 小时和 500 条，先到期先淘汰；被淘汰后按 `runId` 查询返回 404，同键请求会创建新 run。

同一执行可能同时被多个客户端观察，但同一时刻只应有一个由执行租约保护的设备变更者。Run 记录本身不提供跨实例协调。

## 2. 唯一状态来源

执行相关的“正在运行吗”“完成了吗”“是不是同一个任务”分别由不同对象回答，不能互相替代。

| 观察对象 | 权威来源 | 只回答什么 | 不能据此推断 |
| --- | --- | --- | --- |
| 执行身份与状态 | Run 记录；`GET /api/agent/runs/current`、`GET /api/agent/runs/{runId}` | 本次执行处于 accepted/waiting/running/stopping/终态 | 设备是否空闲、页面是否可见 |
| 活动身份集合与设备占用 | `GET /api/agent/runs/current` 的 `run`、`activeRuns`、`lastRun`、`occupancy` | 当前唯一活动 run、其余 accepted 意图、最近终态，以及设备由 run 还是未纳管执行占用 | 执行结果；`occupancy` 也不能证明租约之外的直接设备使用 |
| 当前 MAA 子进程 | `GET /api/agent/tasks/status`（`maaService.taskStatus`） | 当前是否有一个受管子进程在跑，及其 `taskName`/`stopRequested` | 整个流程是否完成；流程步间等待时它可以是 idle |
| 流程步骤进度 | `GET /api/agent/schedules/execution`（`scheduleExecutionStatus`） | `isRunning`、`currentStep`、`totalSteps`、`currentTask`、`taskResults`，以及当前流程的 `runId` | 看不到进度就推断未运行；`runId` 为空只表示该次流程没有 Run 身份（如 Telegram 等未纳管调用方） |
| 执行租约 | `server/data/maa-execution.lock`；快照中的 `occupancy.lease` | 哪个协作进程在占用设备变更权（`pid`、`source`、`taskName`、`command`、`startedAt`） | 执行结果；租约释放不代表流程成功 |
| 连接健康 | 前端 runtime-status 监测 | 浏览器能否访问后端、当前是否 active | 执行成功、失败或已完成 |
| 页面运行标记 | 页面状态与 `statusStore.isActive` | 当前页面的 UI 投影 | 后台任务所有权或终态 |

规则：

1. **Run 是身份与终态的唯一来源。** 进程 idle、流程 `isRunning=false`、页面卸载或轮询失败都不能直接写成“完成”。
2. **进程 idle 不等于流程完成。** 定时/日常流程在步骤之间会释放子进程（等待、截图、仓库解析、汇报），此时 `tasks/status.isRunning=false`，但流程仍在进行；只有 Run 终态或流程结果才能确认完成。日常流程 Run 只有在自己持有 `schedule.runId` 时才投影步骤；`accepted` 尚未获得执行权、或 `schedule.runId` 指向别的流程时，`progress` 显示等待而不是借用他人的步骤。
3. **流程进度是投影。** `schedules/execution` 与 Run 的 `progress` 来自同一流程状态；纳入 Run 的流程在 `scheduleExecutionStatus.runId` 中带上自己的 `runId`，本身仍不是执行身份。未纳入 Run 的调用（当前为 Telegram 等直接调用方）`runId` 为 `null`。
4. **租约只做互斥。** 它防止协作进程同时操作设备，不记录业务结果；锁文件被回收只说明原持有进程已不存活。
5. **页面不维护第二份运行状态机。** 页面可以缓存展示，但停止、完成、重连后的恢复必须以 Run 快照对账。当前 `statusStore.isActive` 仍由连接监测器按 `tasks/status` 写入；肉鸽、作业与自动化页已停止写入，统一投影由运行状态单源任务处理。

### 2.1 运行快照

`GET /api/agent/runs/current` 返回一个快照，而不是单个 run：

| 字段 | 含义 |
| --- | --- |
| `run` | 当前活动 run；排序为 `stopping` > `running` > `accepted` > `waiting`，同级取最新 |
| `activeRuns` | 全部活动 run，按同一顺序。长度大于 1 表示还有额外 accepted/waiting 意图，调用方不能把它们当作同一个执行 |
| `lastRun` | 按 `finishedAt` 取最近终态；只用于展示，不是调用方自己的身份 |
| `occupancy` | 设备占用投影：`state`、`runId`、`runState`、`sources`、`lease`、`task`、`schedule` |
| `isRunning`/`taskName`/`startTime`/`taskType`/`stopRequested`/`logs` | 旧客户端的任务进程字段，原样保留 |
| `schedule`/`recentLogs` | 旧客户端的流程与日志字段，原样保留。`schedule.runId` 是该次流程的 Run 身份，未纳管调用为 `null` |

`schedule` 是旧字段，现在也作为自检信息：当 `schedule.isRunning` 为真而 `schedule.runId` 为空时，说明设备被一个没有 Run 身份的流程占用，`occupancy.state` 会落在 `external`。

`occupancy.state` 只描述“现在谁在变更设备”：

| 值 | 含义 |
| --- | --- |
| `run` | 当前活动 run 为 `running`/`stopping`，设备归该 run |
| `external` | 检测到任务进程、流程或存活租约，但没有持有执行权的 run（未纳管的直接调用方、更新、Telegram 等） |
| `pending` | 只有不持有执行权的活动意图：`accepted` run，或等待下一关的 `waiting` 作业集 run |
| `idle` | 没有活动 run、任务、流程或存活租约 |
| `unknown` | 租约文件存在但无法解析；不能把它当作空闲 |

`sources` 列出得出该判断的证据组合（`run`、`task`、`schedule`、`lease`）。`lease.state` 为 `free`/`held`/`stale`/`unknown`；`stale` 表示锁文件仍存在但记录的进程已不存活，可以回收，不算占用。`external` 与 `pending` 可以同时有 `runId`（一个待执行的 accepted 或等待中的 waiting 意图）——它们描述的是设备归属，不是 run 身份。`run` 只携带当前 run 的进程/流程投影；作业集 `activeRuns` 条目带有自己的会话进度，即使它不是 `run`。

执行状态没有推送通道；客户端通过 HTTP 轮询观察。浏览器实时预览使用 WebRTC 信令，与任务执行状态无关。


## 3. 生命周期状态

```
accepted ──start──> running ──stop accepted──> stopping ──exit──> stopped
    │                  │                                          └ failed（正常停止路径优先 stopped）
    ├──stop accepted──> stopped（取消，从未执行）
    ├──pre-exec fail──> failed
    └──settle─────────> succeeded
running ──exit──> succeeded / failed / stopped
running ──manual set waits for next entry──> waiting ──next──> running
waiting ──stop──> stopped
任意活动状态 + 服务重启 ──> interrupted（终态，不续跑）
```

| 状态 | 含义 | 设备租约 | 可观察位置 | 状态机允许的下一状态 |
| --- | --- | --- | --- | --- |
| `accepted` | 已落库接受，执行器尚未获得执行权 | 本 run 未持有 | `runs/current.run`；并发时也在 `activeRuns` | `running`、`stopped`（取消）、`succeeded`、`failed` |
| `waiting` | 作业集 manual 模式在两项之间等待用户确认；这是活动状态，不是终态 | 本 run 未持有 | `runs/current.run` 或 `activeRuns`；`progress.phase=waiting_for_next` | `running`（继续下一项）、`stopped`（停止）、`failed` |
| `running` | 执行器已获得执行权（租约后、子进程 spawn 前也短暂处于此状态） | 持有 | run 进度、任务进程或流程进度 | `waiting`（仅 manual 作业集）、`stopping`、`succeeded`、`failed`、`stopped` |
| `stopping` | 停止请求已接受，等待子进程/流程退出 | 持有到退出 | `state=stopping`，任务 `stopRequested` | `stopped`、`failed` |
| `succeeded` | 终态成功 | 已释放 | `result` | 无 |
| `failed` | 终态失败 | 已释放 | `error` | 无 |
| `stopped` | 终态已停止；`result.canceled=true` 表示从未开始的取消 | 已释放 | `result` | 无 |
| `interrupted` | 服务重启时尚未结束 | 未知，可能仍被旧进程占用 | `error.code=AGENT_RUN_INTERRUPTED`；`recovery` | 无 |

约束：

- 终态不可变；重复写入同一终态是幂等的，其他越级转换返回 `AGENT_RUN_STATE_CONFLICT`（409）。
- `accepted` 没有执行权。带 `runId` 的停止会把它直接取消为 `stopped`，`result` 为 `{canceled:true, reason:'stop_requested_before_start'}`，不向设备发送任何命令；取消可以安全重复并保持 200。
- `waiting` 只用于 manual 作业集：它表示集合仍有未执行条目，但当前不持有执行租约。其他客户端可以合法占用设备；此时快照的 `occupancy.state` 为 `external`，等待结束后重新获取租约。等待期间按 `runId` 停止会直接转为 `stopped`，保留逐项结果和未开始项的 `pending`，不发送设备命令。
- 从 `waiting` 继续下一项会重新经过租约与 pre-start 门禁：只有 `waiting` 会转为 `running`；`stopping` 或终态会返回 `AGENT_RUN_STOPPED_BEFORE_START` 并放弃启动。若租约被其他执行占用，继续请求得到可重试的 409（`MAA_EXECUTION_BUSY`），run 保持 `waiting`，不消耗下一项。
- 执行器在获得租约后、产生任何设备副作用前，会通过 `startAgentRunForExecution` 复核身份：只有 `accepted`/`waiting` 会转为 `running`；`stopping` 或终态会返回 `AGENT_RUN_STOPPED_BEFORE_START` 并放弃启动。该错误不对 HTTP 调用方暴露，提交方最终看到自己的 run 为 `stopped`。
- `stopping` 不是终态；调用方必须继续查询，直到 `stopped`、`failed` 或 `interrupted`。重复停止请求返回同一状态。
- `interrupted` 只描述**记录**：服务重启后无法确认原执行结果，因此不自动续跑。`waiting` 的作业集在重启后同样转为 `interrupted`，因为进程内的集合会话没有持久化。它不证明设备已空闲或原 MAA 进程已退出，重新提交前应重新确认连接与设备状态。
- `discard` 仅用于执行前的校验/占用拒绝，会删除记录并释放幂等键；它不是公开状态。


### 响应与状态对应

| 场景 | HTTP | 响应要点 |
| --- | --- | --- |
| 同步执行完成 | 200 | `data.runId`、`data.run`、`pollUrl`、`stopUrl`；`run.state` 为终态 |
| 后台接受执行 | 202 | 同上，并带 `Location`；`X-La-Pluma-Run-Id`；调用方应改为轮询 |
| 幂等重放 | 200/202 | `Idempotency-Replayed: true`，返回原 `runId`；活动 run 返回 202，终态成功/停止返回 200，失败/中断返回错误响应 |
| 执行前占用/校验失败 | 400/409 | 错误响应，`error.details.runId`/`run` 可查；run 为 `failed`，幂等键释放，允许用同键重试 |
| 执行中失败 | 4xx/5xx | 错误响应，`error.details.run` 为 `failed`，幂等键保留 |
| 已停止 | 200 | 成功响应，`data.run.state=stopped` |
| Run 持久化不可用 | 503 | `AGENT_RUN_PERSISTENCE_FAILED`（可重试）或 `AGENT_RUN_STORE_INVALID`（不可重试） |

`enrichAgentRun` 会为活动 run 追加 `progress`：日常流程只有在自己持有 `schedule.runId` 时读取 `schedule.scheduleId/currentStep/totalSteps/currentTask/shouldStop/message`；尚未获得执行权时显示 `等待执行权`，流程状态尚未发布时显示 `等待流程状态`。作业集 run 读取服务端会话：`setId`、`mode`、`phase`（`starting`/`running`/`waiting_for_next`）、`currentStep`/`totalSteps`、`currentTask`、`nextEntry`、`shouldStop` 与逐项 `taskResults`；`waiting` 阶段显示 `等待开始下一关`，会话在服务重启后不存在时按状态回退为等待提示。其他执行读任务进程的 `taskName` 与 `stopRequested`。终态不追加进度。

### 幂等与重试

- `Idempotency-Key` 可选；同一 `operationId` + 同键 + 同输入重放原 run，不重复执行；同键不同输入返回 `AGENT_IDEMPOTENCY_KEY_REUSED`（409）。
- 幂等记录随 Run 持久化，正常重启后仍有效；重启时活动 run 变为 `interrupted`，同键重试只会重放该中断结果，**不会重新执行**；要重试必须换新键。
- 执行中失败（`failed`）保留键，因此同键重试会重放失败；只有执行前拒绝（占用、校验、准入落库失败）会释放键。
- 键的保证受 24 小时/500 条终态保留限制；记录被淘汰后同键请求会创建新 run。
- 未提供键时，每次请求都是新 run；当前 Web UI 未发送幂等键，因此页面重复点击没有服务端去重保护。
- 执行准入前落库失败会阻止执行并把 run 置为 `failed`；服务启动时 Run 存储初始化失败则**纳入 Run 的执行接口**整体关闭（503），不会在无身份记录的情况下执行。运行期写入失败时，准入落库会失败并阻止执行，返回可重试的 503。

## 4. 取消语义

停止是**服务端操作**，不是中止本地读取。入口是 `POST /api/agent/actions/stop`；`runId` 可放在请求体或查询参数中（`links.stop` 使用查询参数），请求体优先。

不带 `runId` 的旧式停止仍然有效：停止当前受管子进程和当前流程，并在存在活动 run 时记录停止意图。`accepted` 的当前 run 会被取消；`waiting` 的当前作业集会直接转为 `stopped`（`waitingRunStopped`）且不发送设备命令；`running` 的会转入 `stopping`。响应保留 `task`、`scheduleStopped`、`stopRequested`，并新增 `deviceStopRequested` 表示是否真的向设备发出了停止命令。

带 `runId` 的目标停止：

| 目标 run 状态 | HTTP | 结果 | 是否发送设备命令 |
| --- | --- | --- | --- |
| `accepted`（是否为 current 均可） | 200 | 立即取消为 `stopped`，`acceptedRunCanceled: true` | 否 |
| `waiting`（manual 作业集；是否为 current 均可） | 200 | 立即转为 `stopped`，`waitingRunStopped: true`，`result` 含逐项汇总，未开始项保持 `pending` | 否 |
| `running` 且是 current | 200 | 记录 `stopping` | 是，`deviceStopRequested` 反映结果 |
| `running` 但不是 current | 409 `AGENT_RUN_NOT_CURRENT` | 拒绝，不改任何 run | 否 |
| `stopping` 且是 current | 200 | 保持 `stopping`，重发设备停止 | 是 |
| `stopping` 但不是 current | 200，`alreadyStopping: true` | 已是停止意图 | 否 |
| 终态 | 200，`alreadyTerminal: true` | 原样返回 | 否 |
| 未知或已淘汰 | 404 `AGENT_RUN_NOT_FOUND` | 无 | 否 |

规则：

- **旧 runId 不会误伤新运行。** 终态旧 run 只返回 `alreadyTerminal`；未开始的旧 run 只会取消它自己；非当前的活动 run 在发出设备命令前被拒绝。
- **停止可安全重试。** `stopping` 与终态的重复请求都返回 200；`stopping` 时会重新尝试设备停止。调用方仍需轮询到终态。
- 停止请求先记录 run 意图，再发送设备命令。若子进程尚未 spawn，执行器在 pre-start gate 看到 `stopping` 会直接放弃启动并转为 `stopped`；若 spawn 已发生但事件尚未处理，`onStarted` 会补发进程/流程停止。
- 停止过程中若子进程/流程正常退出，run 进入 `stopped`；若以错误结束，当前实现按 `stopping` 优先记为 `stopped`。不要在停止请求后把“进程退出”直接当作成功完成。
- 本地 `AbortController` 中止、页面卸载、浏览器断线都**不等于停止**；服务端会继续执行。页面关闭后任务继续运行是预期行为。

### 4.1 日常流程提交与异步接受

手动、Dashboard、cron 与 Agent 日常流程入口共用 `run_daily_flow` 一个执行动作和同一条 Run 生命周期；活动作业入口已有自己的 tracked 动作：

| 入口 | 提交方式 | Run | 同步兼容 |
| --- | --- | --- | --- |
| `POST /api/agent/actions/run-daily-flow` | Agent API；`waitForCompletion` 默认 `true` | 是 | 默认同步返回整个流程结果 |
| `POST /api/agent/schedules/{scheduleId}/execute` | Web UI 手动（`manual`）、Dashboard 快捷（`dashboard-quick-start`）及旧调用方 | 是 | 默认同步；响应保留原 `data` 字段并新增 `runId`/`run`/`pollUrl`/`stopUrl` |
| 定时触发（cron） | `schedulerService.executeScheduledTaskFromCron` | 是 | 无 HTTP 调用方；Run 在流程开始前创建，完成后可从 `/runs/current` 的 `lastRun` 或保留记录查询 |
| `POST /api/agent/activity/run` | 当前活动作业 | 是（`run_current_activity_copilots`） | 已有同步入口；`waitForCompletion` 不适用 |

- `waitForCompletion=false` 时，入口在流程获得执行租约并通过 pre-start gate 后返回 HTTP 202；`data` 同时带 `accepted: true`、`scheduleId`、`totalSteps` 与 `runId`。需要计划内容的 Agent 调用还会返回 `plan`。在此之前发生的占用或校验失败仍同步返回 409/400，run 记为 `failed` 并释放幂等键。
- 流程在步间等待（延迟、截图、解析）时子进程可以是 idle，Run 保持 `running`，`progress.currentStep/totalSteps` 来自 `scheduleExecutionStatus`；这不发布整个流程完成。
- 停止按第 4 节执行：`accepted` 直接取消，`running` 转入 `stopping` 后由流程的 `shouldStop`/中止信号结束；停止后不得启动下一项，最终结果为 `stopped`，`result.summary.taskResults` 保留已完成项。
- 首个请求的幂等键由 `Idempotency-Key` 提供，作用于 `run_daily_flow` 动作；相同 key、相同 `scheduleId` 与 `taskFlow` 重放同一 run。cron 触发没有幂等键，每次触发都是一次新的执行意图；并发触发由执行租约拒绝，被拒绝的触发会留下一个 `failed` 的 `run_daily_flow` 记录。
- 不经过上述 Run 包装、直接调用 `executeScheduleNow` 的入口（当前为 Telegram）不会获得 `runId`；它以 `occupancy.state=external` 出现在快照中，不能当作本契约已覆盖。
- Web UI 入口的提交方式：Dashboard 快捷入口以 `waitForCompletion=false` 提交 `run_daily_flow`，把响应的 `runId` 交给前端控制器观察；活动作业入口保持同步（`waitForCompletion` 不适用），响应中的 `runId` 同样被采纳。两者都不再由前端判断“是否在运行”，全局展示只读 `/runs/current` 快照。
- 兼容细节：旧 `/schedules/{scheduleId}/execute` 曾把校验失败也报成 409 `AGENT_SCHEDULE_ALREADY_RUNNING`。现在占用仍保留该旧码，校验失败改为 400 `AGENT_DAILY_FLOW_REJECTED`；这修正了错误分类，未删除同步入口。

### 4.2 作业集提交、模式与等待下一关

作业集由服务端持有集合身份，全部模式共用一个执行动作 `run_copilot_set`；集合内每个条目仍是同一 Run 下的步骤，不再各自成为独立 Run。

| 模式 | 请求 | Run 行为 | 设备租约 |
| --- | --- | --- | --- |
| `continuous`（默认） | `POST /api/agent/copilot-sets/{setId}/execute` | 一个 Run 执行整个待办队列；同步默认返回旧响应，`waitForCompletion=false` 在取得执行权后返回 202 | 集合执行期间持续持有 |
| `manual` | 同端点，`mode=manual` | 首个条目执行后 Run 转 `waiting`；每次 `POST /api/agent/actions/continue-copilot-set` 执行下一项 | 仅在单个条目执行期间持有；等待时释放 |
| `app` / `cli`（旧模式） | 同端点，`mode=app` 或 `mode=cli` | 均映射为 `continuous`；旧的页面内连续与 maa-cli 连续不再有独立服务端语义 | 同 `continuous` |

- 未传 `mode` 的旧调用保持 `continuous`，响应继续包含 `plan`、`results`、`completed`、`pending`，并新增 `runId`、`run`、`state`、`pollUrl`、`stopUrl`、`mode`、`summary`。旧客户端只读原有字段时行为不变。
- 旧 `app` 模式的页面内“失败继续/失败停止”属于页面编排，不再有独立服务端语义；映射到 `continuous` 后沿用旧 `cli` 行为：一个 MAA 命令失败会结束集合，Run 置为 `failed`，未开始的条目保持 `pending`。页面迁移时应把策略表达为是否继续提交剩余条目，而不是让服务端自动跳过。
- `continuous` 的逐项结果在 `summary.taskResults`：`status` 为 `pending`/`running`/`success`/`failed`/`stopped`。MAA 命令失败时 Run 为 `failed`，响应保留旧错误码 `COPILOT_PLAN_FAILED`（HTTP 422）与 `details.summary`；停止时返回 `stopped`，已完成项为 `success`，未开始项保持 `pending`。组与组之间检查停止意图，停止后不会启动下一组。
- `manual` 在等待阶段返回 HTTP 200，`data.waitingForNext=true` 与 `data.nextEntry`；`run.state=waiting`，`progress.phase=waiting_for_next`。等待不持有租约，`occupancy` 不会把设备算作该 run 所有。
- 继续下一项必须携带 runId。租约被占用时返回可重试的 409 `MAA_EXECUTION_BUSY`，run 保持 `waiting`，已完成条目、选中范围与下一项都不变；停止后继续返回 `alreadyTerminal`，不会启动任何条目。
- `manual` 的条目失败记录在 `summary`（`failedCount`/`errors`/`taskResults`），集合继续等待下一项；全部条目尝试完毕后 Run 为 `succeeded`，是否整体成功由 `failedCount` 判断。集合级错误（计划获取失败、持久化失败）才使 Run 为 `failed`。
- 两种模式都支持 `Idempotency-Key`，作用于 `run_copilot_set`；相同 key 与相同输入重放同一 run。继续下一项不创建新 run，也不使用独立幂等键；同一 run 已在执行时重复继续返回 409 `AGENT_COPILOT_SET_NOT_WAITING`。
- 计划获取失败返回 502 `AGENT_COPILOT_SET_UNAVAILABLE`，属于执行前拒绝：run 为 `failed`，幂等键释放。无效的 `mode`/`selectedIndexes`/`options` 返回 400 `AGENT_VALIDATION_*`，不创建 run；未知的 `raid` 沿用旧行为回退为 `normal`。
- 集合会话保存在服务端进程内。服务重启后活动集合 run 转为 `interrupted`；等待中的集合不会自动续跑，页面必须重新选择并提交。浏览器刷新、页面隐藏或断线只影响观察，不影响集合 run；重新连接后按 `runId` 或 `runs/current` 恢复观察。


## 5. 边界契约

### 5.1 断线未知

- 任何网络失败、超时、离线或无法解析的响应都表示**未知**，不是失败、完成或停止。UI 不得把已知的 `running` 清成 idle。
- 重连后先按已知 `runId` 查询；没有 `runId` 时查询 `runs/current`：`run` 是当前活动执行，`activeRuns` 暴露其他 accepted 意图，`lastRun` 是最近终态。`lastRun` 不是身份安全的：若同一实例期间启动了别的执行，可能与调用方自己的执行无关。
- 调用方应在提交时保存 `runId`，并保留到看到该 run 的终态为止。无法恢复身份时应标记为未知并要求用户确认，不能自动假定成功或重新提交。
- `404` 表示未知或已过保留期，不是成功；服务重启后的活动 run 变为 `interrupted`，重连查询应展示该终态和 `recovery.deviceState=unknown`，而不是继续等待。
- 没有推送通道；轮询间隔、超时和重连退避由客户端决定，但不得改变上述判定。

### 5.2 外部占用

- 协作占用通过锁文件表达。提交执行时租约不可用会返回 409：通用执行是 `MAA_EXECUTION_BUSY`，日常流程入口包装为 `AGENT_EXECUTION_BUSY`，旧定时执行接口返回 `AGENT_SCHEDULE_ALREADY_RUNNING`。错误 `details.owner` 给出占用者元数据。
- 对纳入 Run 的入口，占用属于执行前拒绝：run 为 `failed`，幂等键释放，调用方可用同键安全重试。
- 未纳入 Run 的执行（更新任务、Telegram 指令、维护入口及直接调用 `run-task` 的旧调用方）也持有同一租约。此时 `runs/current.run` 为 `null`，`activeRuns` 为空，但 `occupancy.state` 为 `external`，`sources` 包含 `task`、`schedule` 或 `lease`。不能因为 Run 为空就认为设备空闲。定时日常流程与作业集已纳入 Run；若 `schedule.isRunning` 而 `schedule.runId` 为空，说明占用来自未纳管的直接调用方。等待下一关的 manual 作业集 run 为 `waiting`，同样不持有租约；只有其他执行占用时 `external` 才会出现。
- `occupancy.lease.state=held` 表示租约记录的 PID 仍存活；`stale` 表示锁文件可回收，不算占用；`unknown` 表示锁文件无法解释，必须按“未知”处理而不是空闲。
- 租约只约束协作进程。用户或其他工具直接用 MAA/ADB 操作设备不会被检测，系统不提供对非协作占用的排他保证。
- 锁文件只在持有进程 PID 不存活时回收；PID 存活即视为占用。服务异常退出后，旧 MAA 子进程可能仍在运行，回收租约不代表设备已释放。

### 5.3 manual 等待下一项

服务端已把作业集 manual 模式纳入 Run：首个条目执行后 Run 转为 `waiting`，等待“开始下一关”。等待态归服务端，页面只负责展示和发起继续请求。Web UI 的作业页已按该契约迁移：manual 提交一次集合 run，页面展示 `nextEntry` 并在用户点击“开始下一关”时调用继续端点；页面不再逐项提交 `run-task`，也不再维护等待态。

等待态必须满足的不变量：

1. 等待期间不持有设备租约，其他客户端可以合法占用；占用时 `occupancy.state` 为 `external`，而集合 run 仍是 `waiting`。
2. 作业集身份在页面隐藏、刷新后仍可观察：`runs/current` 的 `activeRuns` 包含该 `waiting` run，`progress` 给出 `phase=waiting_for_next`、`nextEntry` 与逐项结果。
3. 用户继续时重新获取租约；若被其他客户端占用，返回可重试的 409 `MAA_EXECUTION_BUSY`，集合保持等待态，不丢失已完成的条目和选中范围，也不消耗下一项。
4. 等待期间停止必须结束集合 run 并阻止下一项；停止直接转为 `stopped`，`result.summary` 保留已完成项，未开始项保持 `pending`；重复停止返回同一终态。
5. 每个条目的结果、失败汇总和“是否还会继续”都归属于集合 `runId`：`summary.taskResults`、`errors`、`waitingForNext`/`nextEntry` 随 Run 返回，而不是页面闭包。
6. 服务重启后等待中的集合 run 转为 `interrupted`；集合会话不持久化，不能自动恢复“下一项”。页面应重新选择并提交。

与日常流程的步间延迟区分：后者由服务端流程在运行期间持有租约，延迟只是流程内部推进，不是“等待用户决定是否继续”；manual 等待则是释放租约、等待外部确认的独立阶段，用 `waiting` 显式表达。

### 5.4 页面隐藏与文档不可见

- `Activity` 隐藏保留页面状态、清理 Effects；它不改变后台执行所有权。隐藏不发送停止，也不代表完成；恢复后应重新查询 Run/流程状态再展示。
- 隐藏期间轮询停止是预期行为；在途异步处理器不会被 Effect 清理自动取消，不能把它们的完成当成页面生命周期仍在的信号。
- `document.hidden` 只影响预览、部分轮询等可见性相关会话，不影响 Run；执行完成的通知与状态不由文档可见性决定。
- 当前 `usePageVisible` 只读取浏览器可见性，不代表 tab 是否选中；不得用它推断执行状态。

### 5.5 刷新与重新挂载

- 浏览器刷新会销毁页面状态，但服务端 run 继续。新页面实例必须按 `runId` 或 `runs/current` 重新观察，**不得因此重新提交任务**。
- 真正卸载/重新挂载同样不改变所有权；页面内未完成的 Promise 不能作为恢复依据。
- 当前客户端统一通过执行控制器保存身份、观察快照并按 `runId` 恢复；肉鸽、作业、自动化及总览均不依靠 `tasks/status` 推断任务终态。刷新只能恢复观察，不能重提执行。

### 5.6 旧断点转换

`localStorage['maa-task-flow-execution']` 是旧版 Automation 前端流程引擎的断点：包含 `isExecuting`、`tasks`、`currentIndex`、`startTime`，逐步写入，完成/停止/失败时删除，超时保留。它包含执行语义，不是普通配置。

旧断点兼容规则：

1. 只读一次，作为一次性兼容输入；不得把它当作 run 身份，也不得写入新的执行断点。
2. 若能关联到匹配的活动/终态 Run，只观察该 Run 并删除旧键；不得重新提交。
3. 无法关联、版本不符或已过期时，标记失效并删除，提示用户重新启动；不得自动续跑。
4. 与活动 Run 冲突时以 Run 为准，不并行启动第二套流程。
5. 首次读取后删除旧键；清理失败也不能导致执行提交，页面不得再次写入此键。

当前自动化页不再写这个键，也没有第二套前端流程引擎。页面在首次拿到 Run 快照时读取一次旧键，按 `snapshot.schedule.runId` 与 `activeRuns` 关联活动 `run_daily_flow`，或关联在旧键写入时已经活动、随后结束的 `lastRun`；关联成功只调用执行控制器 `observeRun(runId, 'run_daily_flow', 'automation')` 并删除旧键。

- 格式错误、版本不符、超过 24 小时（与 Run 终态保留期一致）、没有可关联 Run 时，删除旧键并提示重新开始，不自动续跑。
- 有其它活动 run，或流程正在运行但没有 Run 身份（未纳管调用方/旧服务端）时按冲突处理：删除旧键，不接管该流程，也不启动第二条流程。
- 旧键删除失败只影响清理；页面从不根据旧键提交执行，下一次启动会再次检查。
- 支持范围依赖服务端快照能给出 Run 身份。回退到旧服务端时旧断点无法关联，只会被清理并提示重新开始。

### 5.7 服务重启与持久化失败

- 启动时恢复 Run 存储：终态保留；所有 `accepted`/`waiting`/`running`/`stopping` 记录改为 `interrupted`，写入 `error.details.reason=server_restart`、`previousState` 和当前 `finishedAt`，不自动续跑。
- `interrupted` 的 run 额外返回 `recovery`：`source`、`previousState`、`executionResumed=false`、`deviceState='unknown'`。可恢复的只有记录身份与终态；执行不会恢复，设备是否仍被旧进程占用无法证明。`/runs/current` 的 `lastRun` 会展示该记录，`occupancy` 不会因为存在终端 run 而把设备标成空闲以外的结论——它按新的任务/流程/租约观测重新判断。
- 定时任务由运行时初始化按已保存的自动化配置重新注册；它与被中断的 Run 没有续跑关系，之后可以独立触发新的执行。
- Run 存储文件损坏、版本不支持或启动恢复失败时，纳入 Run 的执行接口保持关闭（503），不能用无身份记录的方式继续执行。运行期写入失败按上一条处理：阻止新的准入并返回可重试的 503。
- 服务正常退出不会自动把活动 run 写成终态；下次启动才做 `interrupted` 转换。退出时也不保证终止已 detach 的 MAA 子进程（非 Windows），因此重启后的设备占用需要重新确认。
- 记录被 24 小时/500 条保留策略淘汰后，按 id 查询返回 404：这是“未知或已失效”，不是成功。


## 6. 执行入口覆盖

“纳入 Run”指该入口通过 `beginAgentRun`/`executeTrackedAgentAction` 创建服务端 run，并在响应中返回 `runId`。判定依据见 `server/routes/agent.js` 与 `server/routes/agentContract.js`。

| 入口 | 端点/调用方 | Run | 租约/执行方式 | 进度来源 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 活动作业 | `POST /api/agent/activity/run` | 是（`run_current_activity_copilots`） | 流程全程持有 | run 进度 | Agent API，同步 |
| 启动游戏 | `POST /api/agent/actions/start-game` | 是（`start_game`） | 命令期间持有 | run 进度 | 支持 `waitForCompletion=false` |
| 理智作战 | `POST /api/agent/actions/fight` | 是（`fight`） | 命令期间持有 | run 进度 | 支持 dry-run |
| 单任务/通用任务 | `POST /api/agent/actions/run-task` | 是（`run_task`） | 命令期间持有 | run 进度 | Web UI 的单作业、肉鸽、仓库/干员识别都走这里 |
| 日常流程（Agent API） | `POST /api/agent/actions/run-daily-flow` | 是（`run_daily_flow`） | 流程全程持有 | `schedule` 投影进 run 进度 | 默认同步；`waitForCompletion=false` 返回 202；dry-run 不创建 run |
| 日常流程（Web UI 手动） | `POST /api/agent/schedules/manual/execute` | 是（`run_daily_flow`） | 流程全程持有 | `schedule` 投影 + `schedule.runId` | 默认同步兼容原响应；自动化页以 `waitForCompletion=false` 提交并观察 Run；异步模式返回 202；重复提交可用幂等键 |
| 日常流程（Dashboard 快捷） | `POST /api/agent/schedules/dashboard-quick-start/execute` | 是（`run_daily_flow`） | 流程全程持有 | 同上 | 同上 |
| 定时触发 | `schedulerService.executeScheduledTaskFromCron` | 是（`run_daily_flow`） | 流程全程持有 | `schedule` 投影 + `schedule.runId` | 无 HTTP 客户端；无幂等键；Run 在开始前创建，供快照观察 |
| 作业集（continuous，含旧 app/cli） | `POST /api/agent/copilot-sets/{setId}/execute` | 是（`run_copilot_set`） | 集合全程持有 | `run.progress` + 响应 `summary`；完成进度落 `copilot-progress.json` | 默认同步兼容原响应；`waitForCompletion=false` 返回 202 |
| 作业集（manual） | `POST /api/agent/copilot-sets/{setId}/execute`（`mode=manual`）与 `POST /api/agent/actions/continue-copilot-set` | 是（`run_copilot_set`；集合级 `waiting`） | 仅单条目执行期间持有；等待释放 | `run.progress` 的 `waiting_for_next`/逐项结果 | 等待期间其他客户端可占用；继续失败可重试且不消耗条目 |
| 逐项 `run-task`（通用入口） | `POST /api/agent/actions/run-task` | 每项是；集合整体否 | 每项命令期间持有 | 每项 run | 页面内的连续编排已退役；其它调用方仍可逐项提交，但不构成集合身份 |
| 旧断点迁移 | 页面启动读取 `maa-task-flow-execution` | 否（只关联已有 run） | 不获取 | 所关联 run 的 progress | 一次性；不重提，见 5.6 |
| 仓库/干员识别 | `POST /api/agent/actions/run-task`（`depot`/`operbox`） | 是 | 命令期间持有 | run 进度 | 后续 `depot-recognition`/`operbox-recognition` 只解析本地日志，不是设备执行 |
| 材料数据更新 | `POST /api/agent/actions/fetch-training-materials` | 否 | 不占设备租约 | 无 | 拉取数据脚本，不是设备自动化 |
| 核心/CLI/资源更新 | `POST /api/agent/actions/update-core`、`update-cli`、`hot-update-resources` | 否 | 全程持有 | 无 | 维护入口；与自动化互斥 |
| 自动更新 | 定时任务 | 否 | 全程持有 | 无 | 无 runId |
| Telegram 指令 | `telegramBotService` 命令 | 否 | 命令期间持有 | 无 | 外部客户端入口；未纳入 HTTP Run 统一包装 |
| 预览/截图/连接测试 | `/webrtc/*`、`/screen/screenshot`、`test-connection` | 否 | 不属于设备自动化执行 | 预览会话/即时响应 | 不适用 Run |

补充判定：

- `setupSchedule`/`stopSchedule`、`apply-training-plan`、配置保存是**配置写入**，不是执行，不产生 run。
- `run-task` 的 `command=activity|list` 被强制为同步；其他命令可后台执行（202）。
- WebRTC 启停、截图和连接测试只管理预览基础设施，不参与执行租约。
- 只有 Agent API 的五个执行动作在 manifest/OpenAPI 中声明 `producesRun`，与上表一致。
- `POST /api/agent/schedules/{scheduleId}/execute` 未在 Agent manifest 中广告，但同样创建 `run_daily_flow`；它和 Agent 入口共享 OperationId 与幂等命名空间。
- `POST /api/agent/copilot-sets/{setId}/execute` 与 `POST /api/agent/actions/continue-copilot-set` 面向 Web UI，未在 Agent manifest 中广告；它们创建/推进 `run_copilot_set`，与其他执行共享同一租约与快照。
- 定时流程与 HTTP 入口使用同一执行租约；同一时刻只有一个流程能进入 pre-start gate，第二个触发会得到占用失败而不是并行执行。

## 7. 兼容约束与支持窗口

| 项目 | 当前行为与兼容约束 | 维护要求 | 对应能力 |
| --- | --- | --- | --- |
| Agent API 响应 | 原有 `data` 字段保留，新增 `runId`/`run`/`pollUrl`/`stopUrl` | 继续只增不减；旧客户端忽略新字段即可 | 契约演进 |
| `/runs/current` | 保留 `task`、`schedule`、`recentLogs`；新增 `activeRuns` 与 `occupancy`，`run`/`lastRun` 语义不变 | 前端从同一快照派生全局运行展示 | 运行状态单源 |
| 目标停止入口 | `links.stop` 与 `stopUrl` 指向 `?runId=<id>`；查询参数与请求体都接受 `runId`；肉鸽、作业与自动化页已统一按 `runId` 停止 | 保持 | 前端执行客户端（控制器）、自动化执行 |
| 旧执行端点 | `schedules/:id/execute` 默认仍同步且保留原 `data`；`copilot-sets/:id/execute` 默认仍同步，保留 `plan`/`results`/`completed`/`pending` 与 `COPILOT_PLAN_FAILED` | 异步模式返回 Run 身份；旧同步入口继续保持 | 日常流程执行、作业集纳入 Run |
| 幂等键 | 可选；服务端完整支持；执行控制器为新提交生成并持久化键；肉鸽、作业与自动化页提交均复用控制器 intent | 保持 | 前端执行客户端（控制器）、自动化执行 |
| `runId` 使用 | 日常流程与作业集所有 HTTP 入口已产生 `runId`；应用级控制器已保存、按 id 查询并恢复观察；肉鸽、作业、自动化与 Dashboard 入口都从控制器快照派生运行展示并在终态前保留身份 | 保持 | 前端执行客户端（控制器）、自动化执行、运行状态单源 |
| accepted 并发的 `current` | `activeRuns` 列出全部活动意图；`run` 按 stopping > running > accepted > waiting、同级取最新 | 调用方不再假定只有一个 accepted | 运行快照 |
| accepted 的停止 | 取消为 `stopped`（`result.canceled=true`），不发设备命令；执行器 pre-start gate 放弃启动 | 保持；集合级停止必须阻止下一项启动 | 运行快照、作业集纳入 Run |
| 作业集模式 | app/cli 映射为 `continuous`，`manual` 使用服务端 `waiting` 会话；旧响应字段保留；作业页只通过集合 run 展示、继续与停止 | 保持 | 作业集执行 |
| 作业集逐项结果 | `summary.taskResults` 覆盖全部范围；失败汇总与 `pending`/`completed` 归属于集合 `runId`；作业页从 `progress`/`summary` 投影展示，不自行拼接 | 保持 | 作业集执行 |
| 忙碌错误码 | Agent 日常流程入口统一为 `AGENT_EXECUTION_BUSY`；`/schedules/:id/execute` 保留 `AGENT_SCHEDULE_ALREADY_RUNNING`；作业集入口与继续下一关保留 `MAA_EXECUTION_BUSY`；底层仍为 `MAA_EXECUTION_BUSY` | 调用方按 `retryable` 与 `details.owner` 重试；旧码继续映射 | 日常流程执行、作业集纳入 Run |
| 日常流程失败 | 占用/校验拒绝释放幂等键；流程已开始后的失败保留键，run 转为 `failed` 并带错误原因 | 调用方修正输入或换键重试 | 日常流程执行 |
| manual 等待 | 服务端 `waiting` run 与显式 `waiting_for_next`；等待不持租约；继续失败可重试且不消耗条目；作业页以服务端 `nextEntry` 渲染“开始下一关”，继续走 `continue-copilot-set` | 保持 | 作业集执行 |
| 旧断点 | 首次快照读取一次，关联活动/终态 `run_daily_flow` 时只观察；失效、过期、冲突与无法关联时删除并提示，从不重提 | 保持；支持窗口 24h，依赖服务端 Run 身份 | 自动化执行 |
| 全局运行展示 | `App` 的应用级投影把唯一快照写成 `statusStore.runStatus`（running/waiting/occupied/unknown/idle）；页面与连接监测器都不再写运行字段，监测器只写连接健康 | 保持；展示与启动入口同源，断线不得写成完成 | 运行状态单源 |
| 定时/更新/Telegram 入口 | 定时日常与作业集已纳入 Run；更新、维护与 Telegram 仍持有租约但未纳管；快照以 `occupancy.state=external` 显式标注 | 维护与外部入口至少显式标注占用 | 日常流程执行、作业集纳入 Run；综合验收 |
| 服务重启 | 活动 run → `interrupted`；`recovery.deviceState=unknown`；不自动续跑 | 重连后先确认设备/连接再重新提交 | 运行快照 |
| 实时性 | 无推送，HTTP 轮询 | 保持轮询契约；不得把推送当作既有前提 | 客户端实现 |

回滚边界：前端回退必须先确认正在执行的 Run、现有持久化记录和外部设备占用；不能删除服务端终态记录或因为旧页面没有新字段就重新提交任务。旧客户端仍可忽略新增的 Run 字段，旧同步入口继续保留默认等待语义；回退前应检查目标版本是否支持 `waiting`、幂等键和按身份停止，避免状态语义退化。完整消费者与移除条件见[兼容性审计](frontend-migration.md)。

## 8. 契约测试清单

### 当前契约测试

| 测试 | 固定的行为 |
| --- | --- |
| `server/services/__tests__/agentRunService.test.js` | 生命周期转换、`waiting` 等待/恢复/停止、终态幂等、幂等键分区/重用拒绝、500 条与 24 小时保留、缺失 run 错误、活动集合与最近终态排序、accepted 取消、pre-start 门禁 |
| `server/services/__tests__/agentRunPersistence.test.js` | 重启后活动 run（含 `waiting`）变 `interrupted` 与 `recovery` 字段、终态恢复、幂等重放跨重启、淘汰写回、坏文件/坏版本 fail-closed、持久化失败可重试、cron 日常流程的终态结果写回磁盘 |
| `server/services/__tests__/runSnapshotService.test.js` | 快照 idle/pending/run/external/unknown、`waiting` 作业集不占设备、租约 free/held/stale/unknown、`lastRun` 与当前身份分离、只有 current 带进度（作业集 run 带自己的会话进度）、日常流程只投影自己持有的 `schedule.runId` |
| `server/routes/__tests__/agentRoutes.test.js` | 按 id 查询、`current` 保留旧字段、快照活动/终态/外部占用、并发 accepted 暴露、租约占用、同步/后台重放、提前后台失败、准入落库失败、重启重放不执行、并发重放读取快照、目标停止矩阵（未知/终态/accepted 取消/waiting 停止/非当前/重复停止/查询参数）、旧 run 不误停新运行、取消后不执行；日常流程同步响应带终态 run、异步 202、步间 idle 时 run 仍活动、停止后不启动下一项、幂等重放与占用错误码映射、cron/旧码兼容；作业集连续同步/异步、app/cli 映射、manual 等待与继续、等待时不占租约、占用可重试不消耗条目、停止后不续跑、逐项汇总归属 runId、幂等重放与执行前占用 |
| `server/routes/__tests__/agentContract.test.js` | manifest/OpenAPI 同步、恰好五个执行动作声明 `producesRun`、202/`Location`/`X-La-Pluma-Run-Id`/`Idempotency-Replayed`、Run 状态枚举（含 `waiting`）与错误结构、快照/占用/恢复/目标停止 schema、`run_daily_flow` 的 `waitForCompletion` 与 `schedule.runId` |
| `server/services/__tests__/copilotSetRunService.test.js` | 连续集合逐项结果、manual 首项后转 `waiting`、等待释放租约、继续前占用返回 409 且不消耗条目、停止等待中的集合并保留逐项结果、条目失败后继续等待、停止后不启动下一项 |
| `server/services/__tests__/copilotPlanService.test.js` | 计划构建、重复文件展开、日志恢复、停止/失败下的逐项状态分类（`success`/`stopped`/`failed`/`pending`） |
| `server/services/__tests__/executionCoordinatorService.test.js` | 租约互斥、同异步流重入、死进程锁回收 |
| `server/services/__tests__/maaTaskExecution.test.js` | 前后台执行路径、失败释放租约、后台缓存保留、pre-start 门禁在 spawn 前生效并释放租约 |
| `server/services/__tests__/schedulerRecovery.test.js` | 异常复位、定时错误可恢复、pre-start 门禁在任何步骤前终止流程、cron 产生单个 `run_daily_flow` 并带终态结果、cron 步间等待仍可观察活动 run、占用时 fail-closed |
| `client/src/features/runtime-status/hooks/useBackendStatusMonitor.test.tsx` | 连接监测的 online/offline/focus 行为；探针只写连接健康，不写运行状态；投影进入忙态后改按 2s 间隔 |
| `client/src/features/runtime-status/hooks/useRunStatusProjection.test.tsx` | 唯一快照投影为 running/waiting/occupied/unknown/idle；断线保留最后活动 run 但标记未知；终态后才回到空闲 |
| `client/src/pages/dashboard/Dashboard.test.tsx` | Dashboard 日常入口单次异步 `run_daily_flow` 幂等提交（`scope: dashboard`）；跨域启动/停止、外部占用与断线未知时全局状态一致；活动预检阻断保留领域原因 |
| `client/src/features/automation/api/index.test.ts` | 旧同步调用不带 `waitForCompletion`/幂等头；后台日常流程写入 `waitForCompletion=false`、`Idempotency-Key` 并转发 signal |
| `client/src/features/automation/model/automationRun.test.ts` | 活动进度取 `run.progress` 与匹配 runId 的 `schedule`；其它 run 的逐项结果不被借用；缺失/不完整结果不伪造状态；终态摘要只来自 `succeeded`/`stopped`；终态通知分类 |
| `client/src/features/automation/model/flowCheckpoint.test.ts` | 旧断点 JSON/版本/24h 时效；活动与终态 `run_daily_flow` 关联；无身份流程与其它活动 run 冲突；删除旧键；删除失败不触发执行 |
| `client/src/pages/automation/AutomationTasks.execution.test.tsx` | 单次 `run_daily_flow` 幂等提交；步间延迟不提前完成；按 `runId` 停止并等待终态；刷新按身份恢复且不重提；其它 run 的 `schedule` 投影隔离；Activity 隐藏/恢复；旧断点有效/终态/失效/过期/冲突；失败、跳过与未执行结果 |
| `client/src/pages/automation/AutomationTasks.activity.test.tsx` | 流程结束时 Activity 隐藏再恢复，完成标记不丢失、不发送停止、不重新提交 |
| `client/src/features/combat/model/copilotSetRun.test.ts` | 集合 run 投影：活动 `progress`、终态 `summary`、突袭/普通条目按作业折叠、等待态 `nextEntry`、缺失进度不伪造完成、终态文案 |
| `client/src/pages/combat/CombatTasks.test.tsx` | 三模式映射（cli/app→continuous、manual）、幂等提交、等待态“开始下一关”与 409 占用重试、失败汇总、按 `runId` 停止后不续跑、停止确认超时重试、hide/show、断线重连、刷新按身份恢复、非本域/非当前集合 run 隔离、上一条记录不冒充完成 |
| `client/src/pages/roguelike/RoguelikeTasks.test.tsx` | 单次幂等提交与命令语义、重复点击不并发、按 `runId` 停止、停止确认中 hide/show 与超时重试、卸载不停止、刷新按身份恢复、非本域 run 隔离、终态消息 |

日常流程的入口覆盖已由 `server/routes/__tests__/agentRoutes.test.js` 与 `server/services/__tests__/schedulerRecovery.test.js` 的新增用例固定：手动、Dashboard 快捷（同一端点）、cron 与 Agent 入口共用一个 `run_daily_flow` 和同一执行租约，旧同步端点保持可用。Dashboard 快捷入口以 `waitForCompletion=false` 提交并交给控制器观察，活动日常入口（`run_current_activity_copilots`）保持同步但同样采纳 `runId`；跨页行为由[集成场景](cross-page-acceptance.md)验证。

作业集的入口覆盖由 `server/services/__tests__/copilotSetRunService.test.js` 与 `server/routes/__tests__/agentRoutes.test.js` 固定：`continuous`（含旧 app/cli）使用单个 `run_copilot_set` 和同一租约；`manual` 首项后转 `waiting`，等待期间租约自由，继续时重新获取；逐项结果与失败汇总写在 run 的 `summary`；停止后不再启动下一项。肉鸽页接入执行控制器并覆盖刷新恢复与停止确认；作业页接入集合 Run，覆盖三模式提交、manual 继续、失败汇总、停止不续跑与恢复路径；自动化页接入 `run_daily_flow`，覆盖单次幂等提交、步间延迟、按 `runId` 停止、刷新恢复与旧断点迁移，页面不再逐项提交 `run-task`。
