# 执行身份与生命周期契约

> [← 返回文档索引](../README.md)

本文说明 La Pluma Next 当前的执行身份、唯一状态来源与生命周期边界，以及必须保留的兼容语义。它面向执行链路、Agent 集成和前端控制器的维护者；不涉及页面视觉。

契约的权威实现是服务端 Run 记录（`server/services/agentRunService.ts`）、运行快照（`server/services/runSnapshotService.ts`）、执行租约（`server/services/executionCoordinatorService.ts`）、作业集会话（`server/services/copilotSetRunService.ts`）、任务进程投影（`server/services/maaProcessService.ts`）和流程进度投影（`server/services/scheduleFlowExecution.ts`，经 `schedulerService.ts` 的公开入口读取）。文档与代码冲突时，以代码和契约测试为准，并修正本文。

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
| `recovery` | 重启恢复边界，仅 `interrupted` 存在 | 见 5.5 |
| `progress` | 活动 run 的进度投影 | 读取时计算，不持久化 |

Run 存储是**单实例**语义：默认持久化到 `server/data/agent-runs.json`，可通过 `LA_PLUMA_AGENT_RUN_STORE` 改路径。不要让多个 Node.js 进程同时读写同一文件。终态最多保留 24 小时和 500 条，先到期先淘汰；被淘汰后按 `runId` 查询返回 404，同键请求会创建新 run。

同一执行可能同时被多个客户端观察，但同一时刻只应有一个由执行租约保护的设备变更者。Run 记录本身不提供跨实例协调。

## 2. 唯一状态来源

执行相关的“正在运行吗”“完成了吗”“是不是同一个任务”分别由不同对象回答，不能互相替代。

| 观察对象 | 权威来源 | 只回答什么 | 不能据此推断 |
| --- | --- | --- | --- |
| 执行身份与状态 | Run 记录；`GET /api/agent/runs/current`、`GET /api/agent/runs/{runId}` | 本次执行处于 accepted/waiting/running/stopping/终态 | 设备是否空闲、页面是否可见 |
| 活动身份集合与设备占用 | `GET /api/agent/runs/current` 的 `run`、`activeRuns`、`lastRun`、`occupancy` | 当前唯一活动 run、其余 accepted 意图、最近终态，以及设备由 run 还是未纳管执行占用 | 执行结果；`occupancy` 也不能证明租约之外的直接设备使用 |
| 当前 MAA 子进程 | `GET /api/agent/tasks/status`（`maaProcessService` 的 `taskStatus`） | 当前是否有一个受管子进程在跑，及其 `taskName`/`stopRequested` | 整个流程是否完成；流程步间等待时它可以是 idle |
| 流程步骤进度 | `GET /api/agent/schedules/execution`（`scheduleExecutionStatus`） | `isRunning`、`currentStep`、`totalSteps`、`currentTask`、`taskResults`，以及当前流程的 `runId` | 看不到进度就推断未运行；`runId` 为空只表示该次流程没有 Run 身份（如 Telegram 等未纳管调用方） |
| 执行租约 | `server/data/maa-execution.lock`；快照中的 `occupancy.lease` | 哪个协作进程在占用设备变更权（`pid`、`source`、`taskName`、`command`、`startedAt`） | 执行结果；租约释放不代表流程成功 |
| 连接健康 | 前端 runtime-status 健康探针 | 浏览器能否访问后端 | 执行是否活动、成功、失败或已完成 |
| 全局运行展示 | `useRunStatusProjection` 从执行控制器写入 `statusStore.runStatus` | 当前 Run 快照的 UI 投影 | 后台任务所有权或独立终态 |

规则：

1. **Run 是身份与终态的唯一来源。** 进程 idle、流程 `isRunning=false`、页面卸载或轮询失败都不能直接写成“完成”。
2. **进程 idle 不等于流程完成。** 定时/日常流程在步骤之间会释放子进程（等待、截图、仓库解析、汇报），此时 `tasks/status.isRunning=false`，但流程仍在进行；只有 Run 终态或流程结果才能确认完成。日常流程 Run 只有在自己持有 `schedule.runId` 时才投影步骤；`accepted` 尚未获得执行权、或 `schedule.runId` 指向别的流程时，`progress` 显示等待而不是借用他人的步骤。
3. **流程进度是投影。** `schedules/execution` 与 Run 的 `progress` 来自同一流程状态；纳入 Run 的流程在 `scheduleExecutionStatus.runId` 中带上自己的 `runId`，本身仍不是执行身份。未纳入 Run 的调用（当前为 Telegram 等直接调用方）`runId` 为 `null`。
4. **租约只做互斥。** 它防止协作进程同时操作设备，不记录业务结果；锁文件被回收只说明原持有进程已不存活。
5. **页面不维护第二份运行状态机。** 页面可以缓存展示，但停止、完成、重连后的恢复必须以 Run 快照对账。`useRunStatusProjection` 是 `statusStore.runStatus` 的唯一写入者；健康探针只写连接健康，页面只消费投影。客户端规则见[执行客户端](execution-client.md)。

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
| `interrupted` | 服务重启或关闭截止时间内未能确认结果 | 未知，可能仍被旧进程占用 | `error.code=AGENT_RUN_INTERRUPTED`；`recovery` | 无 |

约束：

- 终态不可变；重复写入同一终态是幂等的，其他越级转换返回 `AGENT_RUN_STATE_CONFLICT`（409）。
- `accepted` 没有执行权。带 `runId` 的停止会把它直接取消为 `stopped`，`result` 为 `{canceled:true, reason:'stop_requested_before_start'}`，不向设备发送任何命令；取消可以安全重复并保持 200。
- `waiting` 只用于 manual 作业集：它表示集合仍有未执行条目，但当前不持有执行租约。其他客户端可以合法占用设备；此时快照的 `occupancy.state` 为 `external`，等待结束后重新获取租约。等待期间按 `runId` 停止会直接转为 `stopped`，保留逐项结果和未开始项的 `pending`，不发送设备命令。
- 从 `waiting` 继续下一项会重新经过租约与 pre-start 门禁：只有 `waiting` 会转为 `running`；`stopping` 或终态会返回 `AGENT_RUN_STOPPED_BEFORE_START` 并放弃启动。若租约被其他执行占用，继续请求得到可重试的 409（`MAA_EXECUTION_BUSY`），run 保持 `waiting`，不消耗下一项。
- 执行器在获得租约后、产生任何设备副作用前，会通过 `startAgentRunForExecution` 复核身份：只有 `accepted`/`waiting` 会转为 `running`；`stopping` 或终态会返回 `AGENT_RUN_STOPPED_BEFORE_START` 并放弃启动。该错误不对 HTTP 调用方暴露，提交方最终看到自己的 run 为 `stopped`。
- `stopping` 不是终态；调用方必须继续查询，直到 `stopped`、`failed` 或 `interrupted`。重复停止请求返回同一状态。
- `interrupted` 只描述**记录**：服务重启或关闭时无法确认原执行结果，因此不自动续跑。`waiting` 的作业集在重启后同样转为 `interrupted`，因为进程内的集合会话没有持久化。它不证明设备已空闲或原 MAA 进程已退出，重新提交前应重新确认连接与设备状态。`recovery.source` 区分来源：`server_restart`（启动恢复发现残留活动记录）与 `server_shutdown`（关闭流程在截止时间内没有等到结算）。
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
- 未提供键时，每次请求都是新 run；当前 Web UI 经执行控制器生成并复用逻辑提交的幂等键，具体接线见[执行客户端](execution-client.md)。
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
- 旧 `app` 模式的页面内“失败继续/失败停止”属于页面编排，不再有独立服务端语义；映射到 `continuous` 后沿用旧 `cli` 行为：一个 MAA 命令失败会结束集合，Run 置为 `failed`，未开始的条目保持 `pending`。前端模式与失败策略见[执行客户端](execution-client.md)，不得重新引入页面逐项提交循环。
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

### 5.4 客户端生命周期与旧断点

页面隐藏、卸载、刷新或本地读取中止均不改变服务端执行所有权。客户端只能恢复观察，不能据此停止、宣告完成或重新提交；观察与持久化身份规则见[执行客户端](execution-client.md)。旧 `maa-task-flow-execution` 断点只允许关联已有 Run，格式、24 小时接受期限、冲突和清理规则由[前端兼容入口与移除规则](../frontend/compatibility.md#旧自动化断点的接受与恢复)统一维护。

### 5.5 服务重启与持久化失败

- 启动时恢复 Run 存储：终态保留；所有 `accepted`/`waiting`/`running`/`stopping` 记录改为 `interrupted`，写入 `error.details.reason=server_restart`、`previousState` 和当前 `finishedAt`，不自动续跑。
- `interrupted` 的 run 额外返回 `recovery`：`source`、`previousState`、`executionResumed=false`、`deviceState='unknown'`。可恢复的只有记录身份与终态；执行不会恢复，设备是否仍被旧进程占用无法证明。`/runs/current` 的 `lastRun` 会展示该记录，`occupancy` 不会因为存在终端 run 而把设备标成空闲以外的结论——它按新的任务/流程/租约观测重新判断。
- 定时任务由运行时初始化按已保存的自动化配置重新注册；它与被中断的 Run 没有续跑关系，之后可以独立触发新的执行。
- Run 存储文件损坏、版本不支持或启动恢复失败时，纳入 Run 的执行接口保持关闭（503），不能用无身份记录的方式继续执行。运行期写入失败按上一条处理：阻止新的准入并返回可重试的 503。
- 正常关闭（SIGINT/SIGTERM）先进入 draining 再收尾活动执行：新提交的执行被拒绝，本实例记录的活动 run 收到停止意图，当前任务进程收到 SIGTERM（关闭预算不足时提前升级 SIGKILL），流程与作业集在下一项之前退出。关闭只处理本实例的内存记录与进程内任务进程/流程，不按端口或其他进程的 PID 终止进程。
- 关闭在预算内等待执行器结算，**实际结果决定终态**：已结算的 run 保留执行器写入的 `succeeded`/`failed`/`stopped`；预算耗尽时仍未结算的 run 记为 `interrupted`（`recovery.source=server_shutdown`、`executionResumed=false`），不会写成成功。Run 存储在退出前等待落盘；落盘或执行收尾失败时关闭摘要 `ok=false`，进程以非零退出码结束，其余收尾步骤仍继续执行。
- 重复信号复用同一次关闭，不会在收尾中途再次退出或重复写入停止意图；关闭完成后由新进程重新组装并重新开放准入。
- 异常退出（崩溃、`kill -9` 等）没有关闭流程，仍由下次启动把残留活动记录转为 `interrupted`（`recovery.source=server_restart`）。无论哪种退出，都不保证已 detach 的 MAA 子进程（非 Windows）一定终止，重启后的设备占用需要重新确认。
- 记录被 24 小时/500 条保留策略淘汰后，按 id 查询返回 404：这是“未知或已失效”，不是成功。

### 5.6 运行时关闭与后台触发源

- 运行时初始化把默认定时计划与自动更新注册到同一个触发源注册表，并把停止步骤纳入运行时关闭流程。关闭开始（draining）后注册表拒绝新注册，已经排队的 cron 回调不再启动日常流程或自动更新。
- 关闭顺序固定为：后台触发源与轮询 → 执行收尾（停止活动执行并等待 Run 落盘）→ HTTP 传输 → 预览资源。draining 一旦开始，Run 准入与设备租约都关闭，`beginAgentRun` 返回 503 `AGENT_EXECUTION_SHUTTING_DOWN`，直接申请设备变更权返回 503 `MAA_EXECUTION_SHUTTING_DOWN`；HTTP 执行入口、cron、Telegram 指令、维护更新与作业集继续都经过这两个闸门，不会因为入口不同而绕过。关闭期间的提交（包括携带相同幂等键的重放）返回 503，调用方应改为查询已有 run。读取类接口（查询 Run、任务状态、日志）不经过闸门。
- 执行收尾在触发源停止之后进行：已开始的日常流程与作业集按 §5.5 结算，执行器在预算内写出的实际结果优先；截止时间到达仍未结算的 run 记为 `interrupted`，不会写成成功或重新排队。
- 同一 `scheduleId` 的重复配置替换旧任务而不叠加；全部时间点都注册失败时保留上一份有效注册，部分失败通过返回的 `times` 报告缺失时间点。重复停止是幂等的，目标未注册时也按已完成处理。重启后由运行时初始化按已保存配置重新注册，注册本身不执行流程。
- Telegram Bot 的停止步骤在启动轮询前注册：关闭会中止在途 `getUpdates`、轮询间隔与命令内的等待，停止后不再派发迟到命令。重复初始化或改配置只保留一个轮询会话，offset、授权用户与命令语义保持不变。
- WebRTC 预览的关闭步骤在启动前注册：关闭开始后不再启动新的预览资源，已排定的 viewer 自动回收计时器被取消，同源信令网关断开观看连接并清空一次性票据，本进程启动的信令服务、TURN、Agent 部署与构建子进程被终止。关闭会等待已受理的启动/停止退出，因此启动中关闭不会留下孤儿进程。
- 预览启停只释放本实例拥有所有权的资源：服务启动前已存在的信令服务、TURN 与设备端 Agent 没有所有权记录，停止接口与关闭流程都不会终止它们；关闭也不通过 ADB 清理设备端 Agent。`/api/agent/webrtc/*` 状态中的 `ownership` 用 `managed`/`external`/`none` 区分本实例、外部资源与未运行。


## 6. 执行入口覆盖

“纳入 Run”指该入口通过 `beginAgentRun`/`executeTrackedAgentAction` 创建服务端 run，并在响应中返回 `runId`。判定依据见 `server/routes/agentExecution.ts`、`server/routes/agent.js` 与 `server/routes/agentContract.ts`。

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
| 旧断点迁移 | 页面启动读取 `maa-task-flow-execution` | 否（只关联已有 run） | 不获取 | 所关联 run 的 progress | 一次性；不重提，见 5.4 |
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

## 7. 契约演进与持久化维护

旧 HTTP 入口、响应字段、同步默认值、作业集模式别名及外部调用方的现存消费者、支持窗口和移除条件，统一见[前端兼容入口与移除规则](../frontend/compatibility.md)。新增 Run 字段不授权删除旧字段；客户端按身份观察和停止的约束见[执行客户端](execution-client.md)。

Run 存储当前使用 `version: 1`，只接受该版本并严格校验记录；不支持任意旧版本的自动迁移。后续升级格式必须能读取旧文件，或提供明确迁移路径，并保留 `runId`、终态与幂等记录的一致性。服务端回退前必须确认目标版本能读取当前文件格式；不支持的格式应保持 fail-closed，不得删除 Run 文件来绕过准入关闭。

回退前端前应确认正在执行的 Run、持久化身份与外部设备占用，并检查目标版本对 `waiting`、幂等键和按身份停止的支持。不得清空服务端记录或因为旧页面没有新字段就重提执行。终态记录的 24 小时/500 条保留限制及服务重启中断语义见第 1 节与 5.5。

## 8. 契约测试清单

### 当前契约测试

| 测试 | 固定的行为 |
| --- | --- |
| `server/services/__tests__/agentRunService.test.ts` | 生命周期转换、`waiting` 等待/恢复/停止、终态幂等、幂等键分区/重用拒绝、500 条与 24 小时保留、缺失 run 错误、活动集合与最近终态排序、accepted 取消、pre-start 门禁 |
| `server/services/__tests__/agentRunPersistence.test.ts` | 重启后活动 run（含 `waiting`）变 `interrupted` 与 `recovery` 字段、终态恢复、幂等重放跨重启、淘汰写回、坏文件/坏版本 fail-closed、持久化失败可重试、cron 日常流程的终态结果写回磁盘 |
| `server/services/__tests__/runSnapshotService.test.ts` | 快照 idle/pending/run/external/unknown、`waiting` 作业集不占设备、租约 free/held/stale/unknown、`lastRun` 与当前身份分离、只有 current 带进度（作业集 run 带自己的会话进度）、日常流程只投影自己持有的 `schedule.runId` |
| `server/routes/__tests__/agentRoutes.test.ts` | 按 id 查询、`current` 保留旧字段、快照活动/终态/外部占用、并发 accepted 暴露、租约占用、同步/后台重放、提前后台失败、准入落库失败、重启重放不执行、并发重放读取快照、目标停止矩阵（未知/终态/accepted 取消/waiting 停止/非当前/重复停止/查询参数）、旧 run 不误停新运行、取消后不执行；日常流程同步响应带终态 run、异步 202、步间 idle 时 run 仍活动、停止后不启动下一项、幂等重放与占用错误码映射、cron/旧码兼容；作业集连续同步/异步、app/cli 映射、manual 等待与继续、等待时不占租约、占用可重试不消耗条目、停止后不续跑、逐项汇总归属 runId、幂等重放与执行前占用 |
| `server/routes/__tests__/agentContract.test.js` | manifest/OpenAPI 同步、恰好五个执行动作声明 `producesRun`、202/`Location`/`X-La-Pluma-Run-Id`/`Idempotency-Replayed`、Run 状态枚举（含 `waiting`）与错误结构、快照/占用/恢复/目标停止 schema、`run_daily_flow` 的 `waitForCompletion` 与 `schedule.runId` |
| `server/__tests__/agentContractHttp.test.ts` | 沿实际挂载的 router 图核对每个清单 operation 的唯一挂载与 method/path、Web UI 专用路由不进入 manifest、manifest/OpenAPI 同源输出；对每个公开 operation 用发布 schema 校验有效/无效请求与真实响应，并记录运行时兼容输入与静态 schema 的差异 |
| `server/services/__tests__/copilotSetRunService.test.ts` | 连续集合逐项结果、manual 首项后转 `waiting`、等待释放租约、继续前占用返回 409 且不消耗条目、停止等待中的集合并保留逐项结果、条目失败后继续等待、停止后不启动下一项 |
| `server/services/__tests__/copilotPlanService.test.ts` | 计划构建、重复文件展开、日志恢复、停止/失败下的逐项状态分类（`success`/`stopped`/`failed`/`pending`） |
| `server/services/__tests__/executionCoordinatorService.test.ts` | 租约互斥、同异步流重入、死进程锁回收 |
| `server/services/__tests__/maaTaskExecution.test.ts` | 前后台执行路径、失败释放租约、后台缓存保留、pre-start 门禁在 spawn 前生效并释放租约 |
| `server/services/__tests__/schedulerRecovery.test.ts` | 异常复位、定时错误可恢复、pre-start 门禁在任何步骤前终止流程、cron 产生单个 `run_daily_flow` 并带终态结果、cron 步间等待仍可观察活动 run、占用时 fail-closed |
| `server/services/__tests__/scheduleTriggerLifecycle.test.ts` | 重复配置替换而不叠加、全部/部分注册失败、停止与销毁幂等、销毁失败上报关闭步骤、draining 后拒绝注册并丢弃已排队回调、活动流程终态仍由执行结算 |
| `server/services/__tests__/telegramBotLifecycle.test.ts` | 长轮询独立时限与会话取消、停止撤销退避等待、重复初始化只保留一个轮询者、停止后不执行迟到命令、授权与 offset/命令语义、未知 update 校验与 offset 推进、命令解析与领域输入缺省值、未知/失败命令与截图失败回复、原生 multipart 上传字段与文件名、运行时关闭步骤幂等 |
| `server/services/__tests__/webrtcPreviewOwnership.test.ts` | 外部 server/TURN/设备 Agent 不被停止、本实例 server/TURN/设备 Agent 的停止与 `ownership` 上报、关闭中止在途启动并终止本实例子进程、关闭取消 viewer 自动回收、重复关闭幂等、关闭后拒绝启动 |
| `server/services/__tests__/webrtcSignalingGateway.test.ts` | 一次性票据签发与重放拒绝、过期票据与路径白名单、按设备登记 viewer、非法或越权升级不消耗票据、关闭断开观看连接并清空票据、重新挂接后旧票据不可用 |
| `server/services/__tests__/executionShutdown.test.js` | draining 后 Run 准入与设备租约拒绝、cron 与租约入口（Telegram/维护更新共用）不可绕过、只停止本实例的活动执行与进程内任务、执行器实际结果优先、预算耗尽记为 `interrupted`（`server_shutdown`）、Run 落盘失败使关闭步骤失败、重复关闭复用摘要、等待中的作业集不再继续下一项、重启重放不续跑、SIGTERM/SIGINT 子进程退出码 |
| `server/services/__tests__/executionShutdownMaa.test.js` | 假 CLI 前台执行在关闭时收到 SIGTERM 并按实际结果结算为 `stopped`、忽略 SIGTERM 时在预算内升级 SIGKILL、租约释放 |
| `server/services/__tests__/runtimeInitializationService.test.js` | 调度停止端口先于持久配置恢复挂接、恢复只注册不执行、单项恢复失败与接入失败隔离 |

客户端控制器、各领域接线与全局投影的回归入口见[执行客户端](execution-client.md#7-回归清单)；跨页场景见[跨页面集成验收](../development/integration.md)。本表只维护服务端身份、状态机、持久化与执行入口的契约测试。
