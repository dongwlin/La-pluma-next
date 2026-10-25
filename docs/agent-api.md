# Agent API 使用指南

> [← 返回 README](../README.md)

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

# 轮询运行快照：当前 run、全部活动意图、最近终态与设备占用
curl 'http://localhost:3000/api/agent/runs/current?lines=80'

# 按启动响应中的 runId 查询本次执行，即使任务已经结束仍可读取终态
curl 'http://localhost:3000/api/agent/runs/00000000-0000-4000-8000-000000000000'

# 只终止指定 run，避免误停随后启动的其它任务；也可使用响应里的 stopUrl/links.stop
curl -X POST http://localhost:3000/api/agent/actions/stop \
  -H 'Content-Type: application/json' \
  -d '{"runId":"00000000-0000-4000-8000-000000000000"}'
```

所有标准响应都包含 `success`、`message` 和 `meta`。真实执行响应还包含稳定的 `runId`、`run`、`pollUrl` 和 `stopUrl`；后台接受执行时返回 HTTP `202`。Dry-run 响应会设置 `meta.dryRun: true`；失败响应的 `error` 包含稳定的 `code`、`details` 与 `retryable`，执行器忙碌时返回 HTTP `409`。执行身份、唯一状态来源、停止语义和断线/占用/刷新等边界的完整约定见[执行身份与生命周期契约](execution-lifecycle.md)。

`runs/current` 返回运行快照：`run` 是当前活动 run，`activeRuns` 列出全部活动意图（多个 `accepted` 时不会只剩一个），`lastRun` 是最近终态，`occupancy` 说明设备由 `run` 还是未纳管执行（`external`）占用，或只是 `pending`、`idle`、`unknown`。`occupancy.lease` 给出协作租约的 `free`/`held`/`stale`/`unknown` 状态和占用者。旧字段 `isRunning`、`taskName`、`schedule`、`recentLogs` 保持原样。行为不变的部分：进程 idle 不代表流程完成，`lastRun` 也不是调用方自己的身份。

目标停止按 `runId` 保护：`accepted` 会被直接取消（`result.canceled=true`，不发设备命令）；`running` 的当前 run 转入 `stopping` 并发送停止；旧终态 run 返回 `alreadyTerminal`，不会影响新执行；重复停止保持成功。响应中的 `stopRequested` 表示停止意图已记录，`deviceStopRequested` 表示是否真的发出了设备停止命令。

`Idempotency-Key` 是可选请求头，适用于活动作业、启动游戏、理智作战、通用任务和今日流程。幂等键按执行动作分区；同一动作使用相同 key 和相同请求参数重试时不会再次启动，而是返回原 `runId`，对象键顺序不影响比较，但显式参数差异会被视为不同输入。相同 key 搭配不同输入会返回 `AGENT_IDEMPOTENCY_KEY_REUSED`。Run 与幂等记录默认持久化到 `server/data/agent-runs.json`，正常重启后仍会保留；重启时尚未结束的 run 会变为不可自动重试的 `interrupted`，返回 `recovery` 说明记录可读但执行未恢复、设备状态未知，且不会自动续跑。终态最多保留 24 小时和 500 条，达到数量上限时可能提前淘汰；被淘汰的 `runId` 查询返回 404。


当前持久化保证以单个 La Pluma Next 服务实例为边界。不要让多个 Node.js 进程同时读写同一个 Run 存储文件；需要修改路径时可设置 `LA_PLUMA_AGENT_RUN_STORE`。

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

## 养成队列与任务流程

添加目标和生成预览不会首次应用任务流程。先调用 `POST /api/agent/training/plan`（`mode` 为 `current` 或 `all`），再将返回的计划原样放入 `POST /api/agent/actions/apply-training-plan` 的 `plan` 字段。必须保留 `queueRevision`；队列已变化或缺少版本时应用返回 HTTP `409`，需要重新预览。

`GET /api/agent/training/queue` 返回队列 `revision` 和 `flowSync`。同步状态为 `not_applied`、`synced` 或 `failed`，并提供实际的 `flowName`、`taskName`。显式应用后，添加、移除和排序会按已应用的计划范围同步智能养成关卡；清空队列会移除智能关卡，保留普通关卡。

队列变更响应中的 `queueUpdated: true` 表示队列已保存。即使请求成功，仍须检查 `flowSync.status`：`failed` 表示任务流程尚未同步，可调用 `POST /api/agent/training/sync` 重试，无需重复添加或删除。添加接口支持从零开始的 `position`，用于原位恢复；排序接口要求 `operatorIds` 包含全部队列项且不能重复。
