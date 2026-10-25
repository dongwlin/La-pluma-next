# 执行身份与生命周期契约

> [← 返回 README](../README.md)

本文固定 La Pluma Next 在 `0479065` 上的执行身份、唯一状态来源和生命周期边界，并区分**现行行为**与**后续迁移要交付的目标契约**。它面向执行链路、Agent 集成和前端控制器的维护者；不涉及页面视觉，也不改动现有生产逻辑。

契约的权威实现是服务端 Run 记录（`server/services/agentRunService.js`）、执行租约（`server/services/executionCoordinatorService.js`）、任务进程投影（`server/services/maaService.js`）和流程进度投影（`server/services/schedulerService.js`）。文档与代码冲突时，以代码和契约测试为准，并修正本文。

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
| `links.self` / `links.stop` | 按 id 查询与停止入口 | `stop` 当前为通用停止端点 |
| `progress` | 活动 run 的进度投影 | 读取时计算，不持久化 |

Run 存储是**单实例**语义：默认持久化到 `server/data/agent-runs.json`，可通过 `LA_PLUMA_AGENT_RUN_STORE` 改路径。不要让多个 Node.js 进程同时读写同一文件。终态最多保留 24 小时和 500 条，先到期先淘汰；被淘汰后按 `runId` 查询返回 404，同键请求会创建新 run。

同一执行可能同时被多个客户端观察，但同一时刻只应有一个由执行租约保护的设备变更者。Run 记录本身不提供跨实例协调。

## 2. 唯一状态来源

执行相关的“正在运行吗”“完成了吗”“是不是同一个任务”分别由不同对象回答，不能互相替代。

| 观察对象 | 权威来源 | 只回答什么 | 不能据此推断 |
| --- | --- | --- | --- |
| 执行身份与状态 | Run 记录；`GET /api/agent/runs/current`、`GET /api/agent/runs/{runId}` | 本次执行处于 accepted/running/stopping/终态 | 设备是否空闲、页面是否可见 |
| 当前 MAA 子进程 | `GET /api/agent/tasks/status`（`maaService.taskStatus`） | 当前是否有一个受管子进程在跑，及其 `taskName`/`stopRequested` | 整个流程是否完成；流程步间等待时它可以是 idle |
| 流程步骤进度 | `GET /api/agent/schedules/execution`（`scheduleExecutionStatus`） | `isRunning`、`currentStep`、`totalSteps`、`currentTask`、`taskResults` | 执行身份；它也可能代表定时或未纳入 Run 的流程 |
| 执行租约 | `server/data/maa-execution.lock` | 哪个协作进程在占用设备变更权（`pid`、`source`、`taskName`、`command`、`startedAt`） | 执行结果；租约释放不代表流程成功 |
| 连接健康 | 前端 runtime-status 监测 | 浏览器能否访问后端、当前是否 active | 执行成功、失败或已完成 |
| 页面运行标记 | 页面状态与 `statusStore.isActive` | 当前页面的 UI 投影 | 后台任务所有权或终态 |

规则：

1. **Run 是身份与终态的唯一来源。** 进程 idle、流程 `isRunning=false`、页面卸载或轮询失败都不能直接写成“完成”。
2. **进程 idle 不等于流程完成。** 定时/日常流程在步骤之间会释放子进程（等待、截图、仓库解析、汇报），此时 `tasks/status.isRunning=false`，但流程仍在进行；只有 Run 终态或流程结果才能确认完成。
3. **流程进度是投影。** `schedules/execution` 与 Run 的 `progress` 来自同一流程状态，但本身没有 run 身份；未纳入 Run 的定时触发也能出现在这里。
4. **租约只做互斥。** 它防止协作进程同时操作设备，不记录业务结果；锁文件被回收只说明原持有进程已不存活。
5. **页面不维护第二份运行状态机。** 页面可以缓存展示，但停止、完成、重连后的恢复必须以 Run 快照对账。当前页面与连接监测器仍会争写 `statusStore.isActive`，这是待统一的现状，不是契约。

执行状态没有推送通道；客户端通过 HTTP 轮询观察。浏览器实时预览使用 WebRTC 信令，与任务执行状态无关。

## 3. 生命周期状态

```
accepted ──start──> running ──stop accepted──> stopping ──exit──> stopped
    │                  │                                          └ failed（正常停止路径优先 stopped）
    ├──stop accepted──> stopping
    ├──pre-exec fail──> failed
    └──settle─────────> succeeded
running ──exit──> succeeded / failed / stopped
任意活动状态 + 服务重启 ──> interrupted（终态，不续跑）
```

| 状态 | 含义 | 设备租约 | 可观察位置 | 状态机允许的下一状态 |
| --- | --- | --- | --- | --- |
| `accepted` | 已落库接受，执行器尚未开始 | 本 run 未持有 | `runs/current.run`；进度文案通常为“等待任务启动” | `running`、`stopping`、`succeeded`、`failed`、`stopped` |
| `running` | 执行器已启动 | 持有 | run 进度、任务进程或流程进度 | `stopping`、`succeeded`、`failed`、`stopped` |
| `stopping` | 停止请求已接受，等待子进程/流程退出 | 持有到退出 | `state=stopping`，任务 `stopRequested` | `stopped`、`failed` |
| `succeeded` | 终态成功 | 已释放 | `result` | 无 |
| `failed` | 终态失败 | 已释放 | `error` | 无 |
| `stopped` | 终态已停止 | 已释放 | `result` | 无 |
| `interrupted` | 服务重启时尚未结束 | 未知，可能仍被旧进程占用 | `error.code=AGENT_RUN_INTERRUPTED` | 无 |

约束：

- 终态不可变；重复写入同一终态是幂等的，其他越级转换返回 `AGENT_RUN_STATE_CONFLICT`（409）。
- `accepted` 没有执行权，带 `runId` 的停止请求返回 `AGENT_RUN_NOT_STARTED`（409，可重试）；当前不会向设备发送停止命令。状态机内部允许 `accepted → stopping/stopped`，但只可能由不带 `runId` 的旧式停止与并发进程组合触发，属于待收敛行为，不是目标契约。
- `stopping` 不是终态；调用方必须继续查询，直到 `stopped`、`failed` 或 `interrupted`。
- `interrupted` 只描述**记录**：服务重启后无法确认原执行结果，因此不自动续跑。它不证明设备已空闲或原 MAA 进程已退出，重新提交前应重新确认连接与设备状态。
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

`enrichAgentRun` 会为活动 run 追加 `progress`：日常流程读 `schedule.currentStep/totalSteps/currentTask/message`，其他执行读任务进程的 `taskName` 与 `stopRequested`。终态不追加进度。

### 幂等与重试

- `Idempotency-Key` 可选；同一 `operationId` + 同键 + 同输入重放原 run，不重复执行；同键不同输入返回 `AGENT_IDEMPOTENCY_KEY_REUSED`（409）。
- 幂等记录随 Run 持久化，正常重启后仍有效；重启时活动 run 变为 `interrupted`，同键重试只会重放该中断结果，**不会重新执行**；要重试必须换新键。
- 执行中失败（`failed`）保留键，因此同键重试会重放失败；只有执行前拒绝（占用、校验、准入落库失败）会释放键。
- 键的保证受 24 小时/500 条终态保留限制；记录被淘汰后同键请求会创建新 run。
- 未提供键时，每次请求都是新 run；当前 Web UI 未发送幂等键，因此页面重复点击没有服务端去重保护。
- 执行准入前落库失败会阻止执行并把 run 置为 `failed`；服务启动时 Run 存储初始化失败则**纳入 Run 的执行接口**整体关闭（503），不会在无身份记录的情况下执行。运行期写入失败时，准入落库会失败并阻止执行，返回可重试的 503。

## 4. 取消语义

停止是**服务端操作**，不是中止本地读取：

- `POST /api/agent/actions/stop` 不带 `runId`：停止当前受管子进程和当前流程，并在存在活动 run 时把它转入 `stopping`。适合旧客户端和未纳入 Run 的流程。
- 带 `runId`：只允许停止当前活动 run。`404` 表示未知/已淘汰；终态返回成功且 `alreadyTerminal: true`；`accepted` 返回 `AGENT_RUN_NOT_STARTED`；其他 run 返回 `AGENT_RUN_NOT_CURRENT`。不会误停随后启动的新执行。
- 停止请求可重复：已在 `stopping` 时重复调用仍返回成功；调用方仍需轮询到终态。
- 本地 `AbortController` 中止、页面卸载、浏览器断线都**不等于停止**；服务端会继续执行。页面关闭后任务继续运行是预期行为。
- 停止过程中若子进程/流程正常退出，run 进入 `stopped`；若以错误结束，当前实现按 `stopping` 优先记为 `stopped`。不要在停止请求后把“进程退出”直接当作成功完成。

## 5. 边界契约

### 5.1 断线未知

- 任何网络失败、超时、离线或无法解析的响应都表示**未知**，不是失败、完成或停止。UI 不得把已知的 `running` 清成 idle。
- 重连后先按已知 `runId` 查询；没有 `runId` 时查询 `runs/current` 的 `run`（活动）与 `lastRun`（最近终态），但 `lastRun` 不是身份安全的：若同一实例期间启动了别的执行，可能与调用方自己的执行无关。
- 调用方应在提交时保存 `runId`，并保留到看到该 run 的终态为止。无法恢复身份时应标记为未知并要求用户确认，不能自动假定成功或重新提交。
- `404` 表示未知或已过保留期，不是成功；服务重启后的活动 run 变为 `interrupted`，重连查询应展示该终态而不是继续等待。
- 没有推送通道；轮询间隔、超时和重连退避由客户端决定，但不得改变上述判定。

### 5.2 外部占用

- 协作占用通过锁文件表达。提交执行时租约不可用会返回 409：通用执行是 `MAA_EXECUTION_BUSY`，日常流程入口包装为 `AGENT_EXECUTION_BUSY`，旧定时执行接口返回 `AGENT_SCHEDULE_ALREADY_RUNNING`。错误 `details.owner` 给出占用者元数据。
- 对纳入 Run 的入口，占用属于执行前拒绝：run 为 `failed`，幂等键释放，调用方可用同键安全重试。
- 未纳入 Run 的执行（定时流程、作业集 cli 模式、更新任务、Telegram 指令）也持有同一租约；此时 `/runs/current.run` 可能为 `null`，但 `schedule.isRunning` 或 `tasks/status.isRunning` 为真。不能因为 Run 为空就认为设备空闲。
- 租约只约束协作进程。用户或其他工具直接用 MAA/ADB 操作设备不会被检测，系统不提供对非协作占用的排他保证。
- 锁文件只在持有进程 PID 不存活时回收；PID 存活即视为占用。服务异常退出后，旧 MAA 子进程可能仍在运行，回收租约不代表设备已释放。

### 5.3 manual 等待下一项

作业集 `manual` 模式当前由页面逐项执行：每个条目单独调用 `run-task`，是独立的 Run；条目之间没有在途请求，因而**不持有执行租约**。等待“开始下一关”是页面状态。

目标不变量（等待态的具体字段由作业集迁移任务确定，但必须满足）：

1. 等待期间不持有设备租约，其他客户端可以合法占用。
2. 作业集身份在页面隐藏、刷新后仍可观察；等待状态归服务端，不归页面。
3. 用户继续时重新获取租约；若被其他客户端占用，返回可重试的 409，集合保持等待态，不丢失已完成的条目和选中范围，也不消耗下一项。
4. 等待期间停止必须结束集合 run 并阻止下一项；重复停止幂等。
5. 每个条目的结果、失败汇总和“是否还会继续”都归属于集合 `runId`，而不是页面闭包。

现状：等待态只存在于 `CombatTasks` 组件；刷新后集合上下文与“下一项”丢失，服务端没有集合身份；`cli` 模式则是一个同步请求，整个集合期间持有租约但没有 Run。两种模式都待作业集迁移统一。

与日常流程的步间延迟区分：后者由服务端流程在运行期间持有租约，延迟只是流程内部推进，不是“等待用户决定是否继续”；manual 等待则是释放租约、等待外部确认的独立阶段。

### 5.4 页面隐藏与文档不可见

- `Activity` 隐藏保留页面状态、清理 Effects；它不改变后台执行所有权。隐藏不发送停止，也不代表完成；恢复后应重新查询 Run/流程状态再展示。
- 隐藏期间轮询停止是预期行为；在途异步处理器不会被 Effect 清理自动取消，不能把它们的完成当成页面生命周期仍在的信号。
- `document.hidden` 只影响预览、部分轮询等可见性相关会话，不影响 Run；执行完成的通知与状态不由文档可见性决定。
- 当前 `usePageVisible` 只读取浏览器可见性，不代表 tab 是否选中；不得用它推断执行状态。

### 5.5 刷新与重新挂载

- 浏览器刷新会销毁页面状态，但服务端 run 继续。新页面实例必须按 `runId` 或 `runs/current` 重新观察，**不得因此重新提交任务**。
- 真正卸载/重新挂载同样不改变所有权；页面内未完成的 Promise 不能作为恢复依据。
- 现状缺口：Automation 的旧断点恢复会在刷新后重提剩余步骤；Combat 的 manual 等待态会丢失；其他页面只恢复“后端是否 running”的展示，不恢复 run 身份。目标由执行控制器与各域迁移任务统一。

### 5.6 旧断点转换

`localStorage['maa-task-flow-execution']` 是旧版 Automation 前端流程引擎的断点：包含 `isExecuting`、`tasks`、`currentIndex`、`startTime`，逐步写入，完成/停止/失败时删除，超时保留。它包含执行语义，不是普通配置。

目标转换规则：

1. 只读一次，作为一次性兼容输入；不得把它当作 run 身份，也不得写入新的执行断点。
2. 若能关联到匹配的活动/终态 Run，只观察该 Run 并删除旧键；不得重新提交。
3. 无法关联、版本不符或已过期时，标记失效并删除，提示用户重新启动；不得自动续跑。
4. 与活动 Run 冲突时以 Run 为准，不并行启动第二套流程。
5. 在迁移验证通过前保留读取支持，不提前删除旧键；旧键清理失败不能导致新执行开始。

现状：旧断点恢复会等待后端 idle，然后逐项重新调用 `run-task`，因此刷新后可能重提任务。这是已知缺陷，不是兼容承诺。

### 5.7 服务重启与持久化失败

- 启动时恢复 Run 存储：终态保留；所有 `accepted`/`running`/`stopping` 记录改为 `interrupted`，写入 `error.details.reason=server_restart`、`previousState` 和当前 `finishedAt`，不自动续跑。
- 定时任务由运行时初始化按已保存的自动化配置重新注册；它与被中断的 Run 没有续跑关系，之后可以独立触发新的执行。
- Run 存储文件损坏、版本不支持或启动恢复失败时，纳入 Run 的执行接口保持关闭（503），不能用无身份记录的方式继续执行。运行期写入失败按上一条处理：阻止新的准入并返回可重试的 503。
- 服务正常退出不会自动把活动 run 写成终态；下次启动才做 `interrupted` 转换。退出时也不保证终止已 detach 的 MAA 子进程（非 Windows），因此重启后的设备占用需要重新确认。

## 6. 执行入口覆盖

“纳入 Run”指该入口通过 `beginAgentRun`/`executeTrackedAgentAction` 创建服务端 run，并在响应中返回 `runId`。判定依据见 `server/routes/agent.js` 与 `server/routes/agentContract.js`。

| 入口 | 端点/调用方 | Run | 租约/执行方式 | 进度来源 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 活动作业 | `POST /api/agent/activity/run` | 是（`run_current_activity_copilots`） | 流程全程持有 | run 进度 | Agent API，同步 |
| 启动游戏 | `POST /api/agent/actions/start-game` | 是（`start_game`） | 命令期间持有 | run 进度 | 支持 `waitForCompletion=false` |
| 理智作战 | `POST /api/agent/actions/fight` | 是（`fight`） | 命令期间持有 | run 进度 | 支持 dry-run |
| 单任务/通用任务 | `POST /api/agent/actions/run-task` | 是（`run_task`） | 命令期间持有 | run 进度 | Web UI 的单作业、肉鸽、仓库/干员识别都走这里 |
| 日常流程（Agent API） | `POST /api/agent/actions/run-daily-flow` | 是（`run_daily_flow`） | 流程全程持有 | `schedule` 投影进 run 进度 | 同步；dry-run 不创建 run |
| 日常流程（Web UI 手动） | `POST /api/agent/schedules/manual/execute` | 否 | 流程全程持有 | `schedules/execution` | 同步请求；等待步间延迟也算流程运行 |
| 日常流程（Dashboard 快捷） | `POST /api/agent/schedules/dashboard-quick-start/execute` | 否 | 流程全程持有 | `schedules/execution` | 同上 |
| 定时触发 | `schedulerService.executeScheduledTaskFromCron` | 否 | 流程全程持有 | `schedules/execution` | 无 HTTP 客户端；不产生 runId |
| 作业集（cli 模式） | `POST /api/agent/copilot-sets/:id/execute` | 否 | 集合全程持有 | 响应 `results`/`pending`；进度落 `copilot-progress.json` | 同步请求，无 runId |
| 作业集（app 连续/manual） | `POST /api/agent/actions/run-task`（逐项） | 每项是；集合整体否 | 每项命令期间持有 | 每项 run + 页面状态 | 集合身份只在页面；manual 等待不持有租约 |
| 旧断点续跑 | `run-task`（逐项） | 每项是；流程整体否 | 每项命令期间持有 | 每项 run + `tasks/status` 轮询 | 会重提，见 5.6 |
| 仓库/干员识别 | `POST /api/agent/actions/run-task`（`depot`/`operbox`） | 是 | 命令期间持有 | run 进度 | 后续 `depot-recognition`/`operbox-recognition` 只解析本地日志，不是设备执行 |
| 材料数据更新 | `POST /api/agent/actions/fetch-training-materials` | 否 | 不占设备租约 | 无 | 拉取数据脚本，不是设备自动化 |
| 核心/CLI/资源更新 | `POST /api/agent/actions/update-core`、`update-cli`、`hot-update-resources` | 否 | 全程持有 | 无 | 维护入口；与自动化互斥 |
| 自动更新 | 定时任务 | 否 | 全程持有 | 无 | 无 runId |
| Telegram 指令 | `telegramBotService` 命令 | 否 | 命令期间持有 | 无 | 外部客户端入口；未纳入本轮 Web UI 迁移 |
| 预览/截图/连接测试 | `/webrtc/*`、`/screen/screenshot`、`test-connection` | 否 | 不属于设备自动化执行 | 预览会话/即时响应 | 不适用 Run |

补充判定：

- `setupSchedule`/`stopSchedule`、`apply-training-plan`、配置保存是**配置写入**，不是执行，不产生 run。
- `run-task` 的 `command=activity|list` 被强制为同步；其他命令可后台执行（202）。
- WebRTC 启停、截图和连接测试只管理预览基础设施，不参与执行租约。
- 只有 Agent API 的五个执行动作在 manifest/OpenAPI 中声明 `producesRun`，与上表一致。

## 7. 兼容窗口与已知缺口

| 项目 | 现行兼容/现状 | 目标 | 归属能力 |
| --- | --- | --- | --- |
| Agent API 响应 | 原有 `data` 字段保留，新增 `runId`/`run`/`pollUrl`/`stopUrl` | 继续只增不减；旧客户端忽略新字段即可 | 契约演进 |
| `/runs/current` | 保留 `task`、`schedule`、`recentLogs`；`run` 只含活动 run，`lastRun` 为最近终态 | 增加对未纳入 Run 的外部占用的显式表达；保持旧字段 | 运行快照与目标停止 |
| 旧执行端点 | `schedules/:id/execute`、`copilot-sets/:id/execute` 保持同步响应和现有错误码 | 接入 Run 后仍保留同步兼容入口；新入口尽早返回身份 | 日常流程纳入 Run、作业集纳入 Run |
| 幂等键 | 可选；服务端完整支持；Web UI 未发送 | 控制器为每次逻辑提交生成并持久化键 | 前端执行客户端 |
| `runId` 使用 | Web UI 不保存、不查询，只看 `tasks/status` | 页面/控制器保存到终态并据此恢复 | 前端执行客户端、运行状态单源 |
| accepted 并发的 `current` | 可能有多个 accepted；`current` 按 stopping > running > accepted、同优先级取最新 | 明确唯一活动执行与占用者 | 运行快照与目标停止 |
| accepted 的停止 | 带 runId 返回 `AGENT_RUN_NOT_STARTED`；不带 runId 以进程/流程为准 | 目标停止能安全处理 accepted，不误停其他执行 | 运行快照与目标停止 |
| 忙碌错误码 | `MAA_EXECUTION_BUSY`、`AGENT_EXECUTION_BUSY`、`AGENT_SCHEDULE_ALREADY_RUNNING` 并存 | 统一为可识别的占用错误，保留旧码映射 | 日常流程纳入 Run |
| manual 等待 | 页面状态；刷新丢失；等待不持租约 | 服务端集合身份 + 显式等待态；重获租约失败可重试 | 作业集纳入 Run |
| 旧断点 | 刷新后逐项重提 | 一次性转换/失效，不重提 | 自动化执行迁移 |
| 全局运行展示 | 页面与监测器争写 `statusStore.isActive` | 从唯一 Run 快照派生 | 运行状态单源 |
| 定时/更新/Telegram 入口 | 未纳入 Run，但持有租约 | 定时日常纳入 Run；维护与外部入口至少显式标注占用 | 日常流程纳入 Run；综合验收 |
| 服务重启 | 活动 run → `interrupted`；设备可能仍被旧进程占用 | 重连后不自动续跑，先确认设备/连接 | 运行快照与目标停止 |
| 实时性 | 无推送，HTTP 轮询 | 保持轮询契约；不得把推送当作既有前提 | 客户端实现 |

回滚边界：前端回滚不要求删除服务端已发布的 Run 能力；新增状态、错误码和字段先向后兼容发布，再迁移消费者。Run 存储版本升级必须能读旧文件；不能为了回滚删除已持久化的终态记录。旧断点键在迁移验证完成前只读保留。

## 8. 契约测试清单

### 已有覆盖（本次核验依据）

| 测试 | 固定的行为 |
| --- | --- |
| `server/services/__tests__/agentRunService.test.js` | 生命周期转换、终态幂等、幂等键分区/重用拒绝、500 条与 24 小时保留、缺失 run 错误 |
| `server/services/__tests__/agentRunPersistence.test.js` | 重启后活动 run 变 `interrupted`、终态恢复、幂等重放跨重启、淘汰写回、坏文件/坏版本 fail-closed、持久化失败可重试 |
| `server/routes/__tests__/agentRoutes.test.js` | 按 id 查询、`current` 保留旧字段与活动 run、同步/后台重放、提前后台失败、准入落库失败、重启重放不执行、并发重放读取快照、停止守卫（未知/终态/未开始/非当前）、accepted 不误停旧进程 |
| `server/routes/__tests__/agentContract.test.js` | manifest/OpenAPI 同步、恰好五个执行动作声明 `producesRun`、202/`Location`/`X-La-Pluma-Run-Id`/`Idempotency-Replayed`、Run 状态枚举与错误结构 |
| `server/services/__tests__/executionCoordinatorService.test.js` | 租约互斥、同异步流重入、死进程锁回收 |
| `client/src/features/runtime-status/hooks/useBackendStatusMonitor.test.tsx` | 连接监测的 online/offline/focus 行为与 active 轮询 |
| `client/src/features/automation/pages/AutomationTasks.*.test.tsx` | Activity 恢复、执行接线、停止与连接测试的现有页面行为 |
| `client/src/features/combat/pages/CombatTasks.test.tsx` | 顺序作业集停止后不继续、manual 接线与停止确认 |
| `client/src/features/roguelike/pages/RoguelikeTasks.test.tsx` | 运行观察、停止确认与提交接线 |

### 后续必须补充的契约回归

以下测试尚未存在，属于对应迁移任务的验收前置；在补上之前不能宣称契约已实现：

1. **运行快照**：`current`/按 id 能区分活动 run、最近终态和未纳入 Run 的外部占用；已淘汰/未知 id 返回 404；多个 accepted 时不误导调用方。
2. **目标停止**：旧 `runId` 不得停掉新运行；终态/未开始/非当前的停止结果稳定；重复停止幂等；停止后不再执行下一项。
3. **重启边界**：活动 run 恢复为 `interrupted`；同键重试不执行；换键可重新提交；`interrupted` 不声称设备已释放。
4. **入口覆盖**：手动日常、Dashboard 快捷、定时触发、活动启动各自只产生一个执行归属和一个租约；旧同步端点仍可用。
5. **步间等待**：流程在步骤延迟/截图/解析期间进程 idle，但 run 仍为活动；不得提前发布完成。
6. **作业集模式**：app 连续、cli、manual 的模式映射明确；manual 等待不持租约；刷新后仍可观察；占用时继续可重试且不丢条目；停止阻止下一项。
7. **旧断点**：有效/失效/冲突/版本不符的转换；恢复只观察不重提；旧键删除失败不导致新执行。
8. **客户端恢复**：保存 `runId`、202 后转轮询、409 占用重试、断线未知不误判、重连对账、页面隐藏/刷新不重提。
9. **全局单源**：页面与监测器不再各自写 `isActive`；全局展示从同一快照派生。
10. **跨页一致性**：启动 → 切页 → 停止 → 断线重连 → 刷新后，所有页面显示同一 run 结果；日志/预览等非执行会话不干扰判定。

## 9. 本次核验

在实施仓库根目录执行，实际结果记录于提交说明：

```sh
git diff --check
pnpm --filter la-pluma-next-server verify
```

本次只新增/修订公共文档，未改变生产逻辑、协议、存储格式或视觉基线。文档中的“现行”结论来自 `0479065` 的代码与上表测试；目标契约以“目标/归属”列标注，不代表已经实现。
