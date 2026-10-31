# 运行时初始化、就绪与关闭

> [← 返回文档索引](../README.md)

本文从进程运行时视角说明服务端的组装启动、就绪判定与关闭流程。执行身份、Run 状态机、终态与停止矩阵见[执行身份与生命周期契约](../architecture/execution-lifecycle.md)（其 §5.6 的行为事实在本文保留）；环境变量与部署形态见[部署指南](../guides/deployment.md)；WebRTC 预览的内部机制见 [preview-webrtc](preview-webrtc.md)，本文只写它的关闭挂接。

权威实现是 `server/src/server.ts`（组装入口与信号处理）、`server/src/services/runtimeLifecycleService.ts`（生命周期协调）、`server/src/services/runtimeReadinessService.ts`（就绪投影）、`server/src/services/executionAdmissionService.ts`（执行准入闸门）、`server/src/services/executionShutdownService.ts`（执行收尾）、`server/src/services/runtimeInitializationService.ts`（后台领域恢复）与 `server/src/services/agentRunService.ts`（Run 存储恢复与落盘）。文档与代码冲突时以代码为准。

## 组装与启动顺序

`createLaPlumaServer`（`server/src/server.ts:228`）同步完成组装并接受注入端口：`env`、`host`/`port`、`signalingGateway`、`initializeRunStore`、`initializeRuntime`、`logger`、`closeDeadlineMs`、`executionShutdownOptions` 与 `appPaths`（`server/src/server.ts:60`）。监听端口经 `parsePort` 解析：`PORT` 缺省 3000，取值 0-65535，0 保留随机端口语义（`server/src/config/runtimeConfig.ts:69`）；应用路径按模块位置锚定，与进程 cwd 无关（`server/src/config/runtimeConfig.ts:167`）。HTTPS 由 `LA_PLUMA_HTTPS_CERT_PATH`/`LA_PLUMA_HTTPS_KEY_PATH` 同步校验并决定传输协议（`server/src/server.ts:256`、`server/src/config/runtimeConfig.ts:214`）。启动时若信令网关仍使用上游默认账号，会打印迁移提示（`server/src/server.ts:340`）。

组装按固定顺序注册生命周期步骤，关闭时按注册逆序释放：

| 注册顺序 | 步骤 | start | close |
| --- | --- | --- | --- |
| 1 | `webrtc-preview` | 无 | 释放预览资源（`server/src/server.ts:261`） |
| 2 | `agent-run-store` | 恢复 Run 存储（`server/src/server.ts:266`） | 无 |
| 3 | `http-transport` | 挂载信令网关并监听（`server/src/server.ts:289`） | 关闭网关并排空 HTTP |
| 4 | `execution-shutdown` | 无 | 执行收尾（`server/src/server.ts:303`） |
| 5 | `runtime-initialization` | 恢复后台领域（`server/src/server.ts:308`） | 无 |

组装入口同时创建就绪投影并绑定到应用：`/readiness` 只读生命周期状态、初始化阶段与 Run 存储状态投影（`server/src/server.ts:245`）；应用从 `appPaths` 接收前端产物目录与信令网关（`server/src/server.ts:249`）。关闭顺序由注册顺序取反决定，各模块不在导入时自行启动或停止（`server/src/server.ts:241`）。

`start()` 幂等，重复调用复用同一次启动（`server/src/server.ts:335`）；启动完成后返回按执行顺序记录成功步骤的启动摘要（`server/src/services/runtimeLifecycleService.ts:60`）。启动期间由运行时初始化追加注册的步骤（触发源、Telegram 停止端口）按索引继续遍历（`server/src/services/runtimeLifecycleService.ts:320`）。信令网关在监听步骤才挂载，构造与 Run 存储恢复期间不挂载（`server/src/server.ts:162`）；实际监听端口从 server 地址读取（`server/src/server.ts:293`）。只有生命周期回到 `running` 才打印服务地址（`server/src/server.ts:348`）。

直接执行入口先安装 SIGINT/SIGTERM 处理再调用 `start()`，初始化期间即可响应关闭（`server/src/server.ts:440`）；`startLaPlumaServer` 是一步启动入口（`server/src/server.ts:375`）。

两类失败不会让启动失败：

- `agent-run-store` 恢复失败只记录错误，启动继续；纳入 Run 的执行接口保持关闭（503），就绪端点保持不可就绪（`server/src/server.ts:278`）。
- `runtime-initialization` 抛错被记录并标记初始化失败，HTTP 继续提供，就绪端点在一次完整初始化成功前保持不可就绪（`server/src/server.ts:308`）。

## 就绪判定（/health 与 /readiness）

`/health` 只表示进程仍在应答，不执行 ADB、MAA 或外网探测，供容器存活检查使用（`server/src/app.ts:117`）。`/readiness` 提供独立的就绪判断，三个检查同时满足才返回 200（`server/src/services/runtimeReadinessService.ts:126`）：

| 检查 | 就绪条件 | 不可就绪原因码 |
| --- | --- | --- |
| `lifecycle` | 状态为 `running` | `lifecycle_starting` / `draining` / `lifecycle_closed` / `lifecycle_start_failed` / `runtime_not_attached` |
| `initialization` | 阶段为 `completed` | `initialization_pending` / `initialization_in_progress` / `initialization_failed` |
| `runStore` | 要求初始化时 `ready` | `run_store_unavailable`；未要求时为 `not_required` |

Run 存储的 `ready` 等于已启用且无持久化错误（`server/src/services/agentRunService.ts:366`），启动恢复失败与运行期写入失败都会让它转为不可就绪。快照只读进程内状态，不探测设备与网络；响应只含粗粒度状态与稳定原因码，不含路径、凭据或底层错误文本，并设置 `Cache-Control: no-store`（`server/src/app.ts:124`）。设备与外部依赖的连通性属于诊断信息：设备离线不会让 `/readiness` 失败，也不应触发容器重启。`/health` 与 `/readiness` 均不受 `LA_PLUMA_TOKEN` 约束。关闭一旦开始，生命周期进入 `draining`，`/readiness` 立即不可就绪，而 `/health` 仍为 200；编排应用 `/readiness` 摘除流量，而不是重启容器。

## 执行准入闸门与 503

每次组装安装一个新的准入闸门，进程内重新组装不会继承上一份关闭状态（`server/src/services/executionAdmissionService.ts:10`）。关闭请求一到，`runtime.close` 先关闭准入，早于第一个关闭步骤执行（`server/src/server.ts:364`）。此后：

- 纳入 Run 的入口在 `beginAgentRun` 处拒绝，断言先于幂等重放与存储可用性检查（`server/src/services/agentRunService.ts:963`），返回 503 `AGENT_EXECUTION_SHUTTING_DOWN`；携带相同幂等键的重放同样被拒绝，调用方应改为查询已有 run。
- 直接占用设备租约的入口在 `acquireMaaExecutionLease` 处拒绝，返回 503 `MAA_EXECUTION_SHUTTING_DOWN`；没有 Run 身份的入口（Telegram 指令、维护更新）在同一处被拒绝，已持有的租约与重入调用不受影响（`server/src/services/executionCoordinatorService.ts:236`）。

两种拒绝都是可重试的 503，`details.reason` 携带关闭原因（`server/src/services/executionAdmissionService.ts:57`）。闸门状态只描述本进程：`closed`、原因、关闭时间与被拒绝的准入次数（仅用于诊断与测试），不跨实例协调，也不停止任何资源（`server/src/services/executionAdmissionService.ts:21`）。HTTP 执行入口、cron、Telegram 指令、维护更新与作业集继续都经过同一闸门；读取类接口（查询 Run、任务状态、日志）不经过闸门。

## draining

`close()` 第一次被调用即进入 `draining`（`server/src/services/runtimeLifecycleService.ts:385`）：

- 拒绝注册新步骤（`RUNTIME_LIFECYCLE_CLOSED`），启动循环不再开始新步骤，启动端口的 `signal` 被取消（`server/src/services/runtimeLifecycleService.ts:217`、`server/src/services/runtimeLifecycleService.ts:325`）。
- draining 期间或之后的启动请求被拒绝（`server/src/services/runtimeLifecycleService.ts:372`）。
- 被取消的启动步骤只有非取消错误才记为启动问题；已受理的 Run 原子写入仍由持久化队列收尾。
- 触发源注册表拒绝新的 cron/自动更新注册（`server/src/services/scheduleTriggerService.ts:506`），已排队的回调被跳过并计数（`server/src/services/scheduleTriggerService.ts:366`）；已开始的流程不被注册表改写终态，仍由实际执行结算。
- 重复关闭（含重复信号）复用第一次的关闭 Promise 与摘要，不会重复执行收尾（`server/src/server.ts:397`）。

已经开始的执行由执行收尾步骤按实际结果结算。注入端口必须遵守取消约定：各恢复步骤在异步等待返回后再次检查取消状态，防止迟到结果恢复定时任务、应用通知配置或启动 Telegram（`server/src/services/runtimeInitializationService.ts:151`）。

## 关闭预算与固定关闭顺序

关闭预算默认 10 秒（`DEFAULT_CLOSE_DEADLINE_MS`，`server/src/services/runtimeLifecycleService.ts:103`），从第一次关闭请求或启动回滚开始统一计算；等待初始化退出与全部逆序释放共用同一截止时间（`server/src/services/runtimeLifecycleService.ts:181`）。初始化等待分到一份份额，超时后记录 `<step>:start` 的 `timeout` 并继续释放（`server/src/services/runtimeLifecycleService.ts:394`）。每个关闭步骤按剩余预算均分，预算耗尽时仍调用释放端口，传入已取消的 signal 与零预算；步骤份额耗尽会取消其 signal，单步失败只记录结果、不阻断后续收尾（`server/src/services/runtimeLifecycleService.ts:244`）。只有 `close` 的步骤（`webrtc-preview`、`execution-shutdown`）表示资源已归本实例，注册时即纳入回收；带 `start` 的步骤在实际受理时才纳入，尚未启动的资源不会被释放（`server/src/services/runtimeLifecycleService.ts:238`）。

关闭顺序固定为：**后台触发源与轮询 → 执行收尾 → HTTP 传输 → 预览资源**（`server/src/server.ts:260`）。

执行收尾（`execution-shutdown`）在一个步骤内完成（`server/src/services/executionShutdownService.ts:150`）：对本实例记录的活动 run 写入停止意图，作业集 run 先经集合会话，避免留下可用于"继续下一关"的会话；任务进程先 SIGTERM，预算不足时提前升级 SIGKILL（默认等待 1500ms，受剩余预算约束）；没有 Run 身份的进程/流程按 300ms 节流重试停止；以 25ms 间隔轮询执行器结算，执行器写出的实际结果优先。收尾先于断开连接执行，仍在等待回复的同步执行可以先按实际结果返回。截止时间到达仍未结算的 run 记为 `interrupted`（`recovery.source=server_shutdown`），绝不写成成功；返回前等待 Run 存储落盘（预留 min(300ms, 预算/3)），落盘失败使本步骤失败（`server/src/services/executionShutdownService.ts:257`）。不经生命周期直接调用收尾时，等待预算缺省同样为 10 秒（`server/src/services/executionShutdownService.ts:137`）。

HTTP 传输关闭先停止接受新连接，等待在途响应完成；每个响应结束后回收转为空闲的 keep-alive 连接；只有传输步骤预算耗尽才强制断开残留连接并记为 `timeout`。信令网关与传输作为同一资源释放，网关关闭失败仍执行 HTTP 排空（`server/src/server.ts:197`）。

## 后台触发源（cron 与自动更新）

运行时初始化（`initializeRuntimeState`，`server/src/services/runtimeInitializationService.ts:147`）在读取任何持久配置之前先挂接调度触发源的停止端口——即使没有已保存配置或恢复失败，关闭时也能停止之后通过 API 注册的 cron/自动更新（`server/src/services/runtimeInitializationService.ts:141`）。随后并行读取通知、自动化任务与自动更新配置并逐项恢复；每个领域在摘要中独立记录成功位与失败原因，互不替代（`server/src/services/runtimeInitializationService.ts:91`）。恢复只注册触发源，不执行流程。

- 定时计划仅在持久配置启用时恢复；恢复前解析当前 profile 的客户端类型，解析失败按默认客户端时区注册，不阻断恢复（`server/src/services/runtimeInitializationService.ts:198`）。
- 同一 `scheduleId` 的重复配置替换旧任务而不叠加：新 job 全部创建并启动成功后才销毁旧 job，全部失败时保留上一份有效注册，部分失败通过返回的 `times` 报告缺失时间点；重复停止是幂等的，目标未注册时也按已完成处理（`server/src/services/scheduleTriggerService.ts:284`）。
- cron 触发经 `executeScheduledTaskFromCron` 创建 `run_daily_flow` 的 Run，与 HTTP 入口共用执行租约和准入闸门（`server/src/services/schedulerService.ts:183`）。
- 关闭步骤 `scheduled-triggers` 调用 `stopAll('runtime-close')` 停止并销毁全部 job；销毁失败使本步骤失败，但不阻断其余领域的收尾（`server/src/services/scheduleTriggerService.ts:765`）。

## Telegram 轮询

Telegram 的停止步骤在实际启动轮询之前挂接：仅当渠道启用且配置了 `botToken` 与 `chatId` 时，先注册 `telegram-bot` 关闭步骤再启动轮询；挂接失败时本次不启动轮询，避免出现关闭流程无法回收的后台长轮询（`server/src/services/runtimeInitializationService.ts:250`）。关闭调用 `stop('runtime-close')`，中止在途 `getUpdates`、轮询间隔与命令内的等待，停止后不再派发迟到命令（`server/src/services/telegramBotService.ts:679`）。重复初始化或改配置只保留一个轮询会话，offset、授权用户与命令语义保持不变。Telegram 初始化失败只记录到摘要的 `telegram` 字段，不影响其他领域的恢复。

## WebRTC 预览的关闭挂接

组装时在启动前注册 `webrtc-preview` 关闭步骤（`server/src/services/webrtcService.ts:1350`）；挂接失败只记录警告，关闭时无法保证释放本地预览资源（`server/src/server.ts:262`）。关闭开始后不再启动新的预览资源；释放时先取消已排定的 viewer 自动回收计时器，再终止本进程拥有的信令服务、TURN、Agent 部署与构建子进程，并等待已受理的启动/停止退出，因此启动中关闭不会留下孤儿进程（`server/src/services/webrtcService.ts:1328`）。预览启停只释放本实例拥有所有权的资源：启动前已存在的信令服务、TURN 与设备端 Agent 没有所有权记录，关闭也不通过 ADB 清理设备端 Agent。预览的内部机制见 [preview-webrtc](preview-webrtc.md)。

## 启动回滚与失败摘要

启动步骤抛错时（例如监听失败），生命周期进入 `start-failed` 并置 draining，以 `start-rollback` 为原因逆序释放已受理或已登记的资源，然后抛出携带步骤名的 `RUNTIME_LIFECYCLE_START_FAILED`（`server/src/services/runtimeLifecycleService.ts:350`）。组装入口的 `start()` 捕获后调用 `runtime.close('start-failed')`——同时关闭执行准入——再重新抛出（`server/src/server.ts:356`）。回滚与后续关闭复用同一次释放及其结果，不掩盖回滚失败。

关闭摘要（`RuntimeLifecycleCloseSummary`）包含 `reason`、`state`、`ok`、`deadlineMs`、`durationMs` 与逐步骤结果（名称、状态 `closed`/`failed`/`timeout`、耗时与失败信息，`server/src/services/runtimeLifecycleService.ts:76`）；只有在全部步骤 `closed` 时 `ok=true`。执行收尾自身的摘要记录 `admission`、已写停止意图的 run 及处理方式、预算内记为中断的 run、进程与流程停止调用次数、落盘结果与去重后的错误列表（`server/src/services/executionShutdownService.ts:61`）；重复关闭复用首次摘要，不会重复写入停止意图。

信号处理复用同一次关闭：重复信号只记录日志并继续等待；关闭结束后按摘要决定退出码——存在非 `closed` 步骤时以非零码退出并打印失败步骤，否则以 0 退出（`server/src/server.ts:386`）。直接执行入口的启动失败同样以退出码 1 结束（`server/src/server.ts:440`）。异常退出（崩溃、`kill -9`）没有关闭流程，由下次启动把残留活动记录转为 `interrupted`（`recovery.source=server_restart`）。
