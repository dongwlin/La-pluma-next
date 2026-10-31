# Agent API 使用指南

> [← 返回文档索引](../README.md)

La Pluma Next 提供一层给 AI/Agent 使用的轻量控制接口。它不是前端内部 API 的简单暴露，而是更语义化的 manifest/status/actions 层，方便 Agent 或自定义自动化发现能力、读取状态和执行动作。Manifest 与 OpenAPI 由同一份能力清单生成，并公开每个动作的风险、dry-run、轮询和停止方式。

## 发现能力

```bash
curl http://localhost:3000/api/agent/manifest
curl http://localhost:3000/api/agent/openapi.json
```

## 读取状态

```bash
curl http://localhost:3000/api/agent/status
```

返回内容会汇总：MAA 版本、任务状态、ADB 连接、前台窗口、WebRTC 预览可用性、最近日志和下一步建议。

连接相关接口默认读取 `profileId: "default"` 对应的连接配置，也可以选择其它已保存配置。显式传入的 `adbPath`、`address` 或 `clientType` 会覆盖该配置中的同名字段。

## 推荐执行流程

```bash
# 检查模拟器连接
curl -X POST http://localhost:3000/api/agent/actions/test-connection \
  -H 'Content-Type: application/json' \
  -d '{"profileId":"default"}'

# WebRTC 实时预览
curl -X POST http://localhost:3000/api/agent/webrtc/start \
  -H 'Content-Type: application/json' \
  -d '{"profileId":"default","deviceId":"mumu-la-pluma"}'

# 启动游戏
curl -X POST http://localhost:3000/api/agent/actions/start-game \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: start-game-20260712-01' \
  -d '{"profileId":"default","waitForCompletion":true}'

# 先检查理智作战计划，不触发 MAA
curl -X POST http://localhost:3000/api/agent/actions/fight \
  -H 'Content-Type: application/json' \
  -d '{"stages":[{"stage":"1-7","times":3}],"medicine":0,"stone":0,"dryRun":true}'

# 检查已保存的今日流程
curl -X POST http://localhost:3000/api/agent/actions/run-daily-flow \
  -H 'Content-Type: application/json' \
  -d '{"dryRun":true}'

# 确认计划后开始今日流程
curl -X POST http://localhost:3000/api/agent/actions/run-daily-flow \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: daily-flow-20260712-01' \
  -d '{"dryRun":false}'

# 立即拿到 runId，稍后再查询终态（流程获得执行权后返回 202）
curl -X POST http://localhost:3000/api/agent/actions/run-daily-flow \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: daily-flow-20260712-02' \
  -d '{"dryRun":false,"waitForCompletion":false}'

# 轮询运行快照：当前 run、全部活动意图、最近终态与设备占用
curl 'http://localhost:3000/api/agent/runs/current?lines=80'

# 按启动响应中的 runId 查询本次执行，即使任务已经结束仍可读取终态
curl 'http://localhost:3000/api/agent/runs/00000000-0000-4000-8000-000000000000'

# 只终止指定 run，避免误停随后启动的其它任务；也可使用响应里的 stopUrl/links.stop
curl -X POST http://localhost:3000/api/agent/actions/stop \
  -H 'Content-Type: application/json' \
  -d '{"runId":"00000000-0000-4000-8000-000000000000"}'
```

### Web UI 专用端点（不在 Agent manifest）

以下端点由 Web UI 使用，未在 `AGENT_OPERATIONS` 中注册，也不会出现在 manifest/OpenAPI 中；Agent 应使用上面的 manifest 动作，而不是依赖这些入口：

```bash
# 日常流程：Web UI 手动触发；默认同步，支持 waitForCompletion=false
curl -X POST http://localhost:3000/api/agent/schedules/manual/execute \
  -H 'Content-Type: application/json' \
  -d '{"taskFlow":[...]}'

# 作业集：continuous（默认，含旧 app/cli）返回集合 runId
curl -X POST http://localhost:3000/api/agent/copilot-sets/12345/execute \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: copilot-set-20260712-01' \
  -d '{"mode":"continuous","raid":"normal","selectedIndexes":[0,1]}'

# 作业集：manual 首项执行后等待下一关，不会自动连续
curl -X POST http://localhost:3000/api/agent/copilot-sets/12345/execute \
  -H 'Content-Type: application/json' \
  -d '{"mode":"manual","selectedIndexes":[0,1]}'

# 继续 manual 作业集的下一项（run 必须处于 waiting）
curl -X POST http://localhost:3000/api/agent/actions/continue-copilot-set \
  -H 'Content-Type: application/json' \
  -d '{"runId":"00000000-0000-4000-8000-000000000000"}'
```

所有标准响应都包含 `success`、`message` 和 `meta`。真实执行响应还包含稳定的 `runId`、`run`、`pollUrl` 和 `stopUrl`；后台接受执行时返回 HTTP `202`。Dry-run 响应会设置 `meta.dryRun: true`；失败响应的 `error` 包含稳定的 `code`、`details` 与 `retryable`，执行器忙碌时返回 HTTP `409`。API 错误经过统一错误出口：`/api` 下未匹配的路径返回 404 `AGENT_ROUTE_NOT_FOUND`；无法解析的 JSON 请求体返回 400 `AGENT_REQUEST_BODY_INVALID`，超过大小限制返回 413 `AGENT_REQUEST_BODY_TOO_LARGE`，字符集不支持返回 415 `AGENT_REQUEST_CHARSET_UNSUPPORTED`；路径参数解码失败返回 400 `AGENT_REQUEST_PATH_INVALID`；用户配置写接口（`POST /api/agent/config/user/{configType}` 与 `POST /api/agent/notifications/config`）的请求体必须是 JSON 对象，其他顶层类型返回 400 `AGENT_CONFIG_DATA_INVALID`。错误状态限制在 400–599；携带业务状态的错误保留其公开 `code`、`message`、`details` 与 `retryable`，`retryable` 只来自错误本身，不按 5xx 推导；未知内部错误统一返回 500 `AGENT_INTERNAL_ERROR`，不泄露内部 message、details 或堆栈。错误响应与错误日志不回显请求查询串。日常流程的 Agent 入口是 `POST /api/agent/actions/run-daily-flow`；Web UI 另使用未在 manifest 中广告的 `/api/agent/schedules/{scheduleId}/execute`，两者共用 `run_daily_flow`，旧同步响应字段保持不变。`POST /api/agent/activity/run`（`run_current_activity_copilots`）始终同步执行，不支持 `waitForCompletion`，也不会返回 202；其 manifest/OpenAPI 声明不包含后台接受响应。Run 状态机与终态、同步与后台接受（202）响应的对应、执行身份、唯一状态来源、停止语义和断线/占用/刷新等边界的完整约定见[执行身份与生命周期契约](../architecture/execution-lifecycle.md)。

作业集入口 `/api/agent/copilot-sets/{setId}/execute` 由 Web UI 使用，未在 Agent manifest 中广告；它使用 `run_copilot_set`。`mode` 可取 `continuous`（默认，旧 `app`/`cli` 也映射到这里）或 `manual`。`continuous` 默认同步返回旧字段并新增 `runId`、`run`、`mode`、`summary`；`waitForCompletion=false` 在取得执行租约后返回 202。`manual` 只执行第一个待办条目然后返回 `waitingForNext: true`、`nextEntry` 与逐项 `summary`，run 进入 `waiting`；随后调用 `POST /api/agent/actions/continue-copilot-set` 携带该 `runId` 执行下一项。`waiting` 期间的租约与占用、停止与逐项状态汇总、服务重启后转 `interrupted` 等集合 Run 行为的完整约定见[执行身份与生命周期契约](../architecture/execution-lifecycle.md)。

请求关联与日志：请求头 `x-request-id` 可选，合法值为 1–64 位字母、数字与 `.`、`_`、`:`、`-`，首字符必须是字母或数字。合法值原样出现在响应头 `x-request-id`、响应 `meta.requestId` 与同一请求的 API 错误日志中；缺失、超长或含其他字符时服务端生成新 id 并在上述三处使用该新 id，非法输入不会回显。执行日志（含 MAA 子进程输出与响应返回后的后台收尾）在纳入 Run 时记录 `runId` 与 `operationId`，未纳入 Run 的直接调用不冒用其他执行的 id；HTTP 请求结束不代表执行完成，仍需以 run 终态或实际进程结果为准。API 错误按级别记录：携带状态且已归类的 4xx 为 WARN，未知内部 5xx 为 ERROR。日志不输出 Authorization、cookie、token、信令 ticket、密码与签名等凭据字段，也不回显请求查询串或请求体。

`runs/current` 返回运行快照：`run` 是当前活动 run，`activeRuns` 列出全部活动意图，`lastRun` 是最近终态，`occupancy` 说明设备由 `run` 还是未纳管执行（`external`）占用，或只是 `pending`、`idle`、`unknown`；旧字段 `isRunning`、`taskName`、`schedule`、`recentLogs` 保持原样，`schedule.runId` 为 `null` 表示该流程没有 Run 身份。快照各字段、占用与租约投影、进度投影及“进程 idle 不代表流程完成”等判定规则的完整约定见[执行身份与生命周期契约](../architecture/execution-lifecycle.md)。

目标停止按 `runId` 保护：未开始的 run 直接取消且不发送设备命令，`running` 的当前 run 转入 `stopping`，旧终态 run 返回 `alreadyTerminal`，不会影响新执行；重复停止保持成功。响应中的 `stopRequested` 表示停止意图已记录，`deviceStopRequested` 表示是否真的发出了设备停止命令；按目标状态区分的完整停止矩阵与取消语义见[执行身份与生命周期契约](../architecture/execution-lifecycle.md)。

`Idempotency-Key` 是可选请求头，适用于活动作业、启动游戏、理智作战、通用任务与今日流程；Web UI 专用的作业集入口和 `/api/agent/schedules/{scheduleId}/execute` 也支持。相同 key、相同输入重试时返回原 `runId`，对象键顺序不影响比较，但显式参数差异会被视为不同输入。幂等键按 `operationId` 分区、同键不同输入的拒绝、重放与键释放规则，以及 Run 与幂等记录的持久化、重启 `interrupted` 语义和终态保留期限的完整约定见[执行身份与生命周期契约](../architecture/execution-lifecycle.md)。


Run 存储以单个 La Pluma Next 服务实例为边界，需要修改路径时可设置 `LA_PLUMA_AGENT_RUN_STORE`；默认存储位置、单实例读写约束与保留策略见[执行身份与生命周期契约](../architecture/execution-lifecycle.md)。

## 通用任务

优先使用 `fight`、`run-daily-flow` 等语义化动作。只有明确知道 MAA CLI 参数时，才使用高风险的通用白名单入口：

```bash
# 执行白名单 maa-cli 任务
curl -X POST http://localhost:3000/api/agent/actions/run-task \
  -H 'Content-Type: application/json' \
  -d '{"command":"award","args":[],"taskName":"领取奖励","waitForCompletion":true}'

# 执行动态任务配置
curl -X POST http://localhost:3000/api/agent/actions/run-task \
  -H 'Content-Type: application/json' \
  -d '{"command":"run","args":["agent-award"],"taskConfig":{"name":"领取奖励","type":"Award","params":{"award":true}},"waitForCompletion":true}'
```

如果设置了 `LA_PLUMA_TOKEN`，Agent API、其它 `/api/*` 以及 WebRTC 同源网关的票据入口都需要 `Authorization: Bearer <token>` 或 `X-La-Pluma-Token`。未设置时认证关闭。

认证失败返回 401 `AGENT_AUTH_REQUIRED`，失败限流返回 429 `AGENT_RATE_LIMITED`，未设置令牌时信令票据入口拒绝跨源请求并返回 403 `AGENT_SIGNALING_ORIGIN_FORBIDDEN`。令牌比较、按来源限流与信令来源规则的完整约定见[部署指南](../guides/deployment.md#跨域与访问来源)；信令凭据与上游账号的迁移要求见[部署指南](../guides/deployment.md#信令凭据与上游端口边界)。

## 养成队列与任务流程

添加目标和生成预览不会首次应用任务流程。先调用 `POST /api/agent/training/plan`（`mode` 为 `current` 或 `all`），再将返回的计划原样放入 `POST /api/agent/actions/apply-training-plan` 的 `plan` 字段。必须保留 `queueRevision`；队列已变化或缺少版本时应用返回 HTTP `409`，需要重新预览。应用成功后服务端会按更新后的 automation 配置重新注册已存在的默认定时任务；响应中的可选 `scheduleSync` 为 `{ attempted, success, message, missingTimes? }`；`attempted: true, success: false` 表示配置与队列已应用但定时注册失败（包括只有部分时间点创建成功，`missingTimes` 列出未注册时间点），客户端应保留计划并给出重试入口。普通队列同步（`/training/sync` 或队列写入触发的自动同步）不会创建或重注册定时任务。

`GET /api/agent/training/queue` 返回队列 `revision` 和 `flowSync`。同步状态为 `not_applied`、`synced` 或 `failed`，并提供实际的 `flowName`、`taskName`。显式应用后，添加、移除和排序会按已应用的计划范围同步智能养成关卡；清空队列会移除智能关卡，保留普通关卡。

队列变更响应中的 `queueUpdated: true` 表示队列已保存。即使请求成功，仍须检查 `flowSync.status`：`failed` 表示任务流程尚未同步，可调用 `POST /api/agent/training/sync` 重试，无需重复添加或删除。添加接口支持从零开始的 `position`，用于原位恢复；排序接口要求 `operatorIds` 包含全部队列项且不能重复。
