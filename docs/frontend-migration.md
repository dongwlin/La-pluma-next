# 前端迁移与兼容审计

> [← 返回文档索引](README.md)

本次整理将页面职责收敛到领域所有者、Query 和执行控制器，保留仍有消费者或支持承诺的入口。当前架构见[前端架构与所有权](frontend-architecture.md)。本文以仓库生产调用、公开导出及兼容测试为依据；只有确认已无消费者且明确支持窗口已经结束，才可删除兼容代码。

## 已收敛的边界

| 迁移内容 | 当前归属 | 行为依据 |
| --- | --- | --- |
| 页面传输、存储、轮询与业务状态 | `pages` 只组合，业务能力经 `features/<domain>/index.ts` 暴露 | [依赖与职责护栏](guardrails.md) |
| 页面自行推断运行、重放任务或泛化停止 | 服务端 Run + 应用级 ExecutionController；新页面提交后观察、停止携带 `runId` | [执行生命周期](execution-lifecycle.md)、[执行客户端](execution-client.md) |
| 三页独立保存与迟到写覆盖 | 按配置 key 的稳定协调器通道与域适配器；自动化配置和 schedule 是一个完整提交单元 | [配置持久化协调器](config-persistence.md) |
| 服务端资源的页面副本与共享端点重复归属 | 领域 Query；共享游戏数据唯一归 `game-data`，写后经精确作用域失效 | [Query 缓存](query-cache.md)、[资源所有权](resource-ownership.md) |
| 巨型页面的规则、命令与展示混杂 | 纯模型、模块级命令所有者、工作区和受控面板 | [前端架构](frontend-architecture.md)、各领域契约 |
| 全局导航与领域样式混杂 | URL 驱动导航、Activity 保活、全局语义 token 与领域 `@layer page` 样式 | [整体架构](architecture.md)、[开发指南](development.md) |

这些变化不等于旧 HTTP 接口、持久化键或外部执行入口已失效。审计结果如下；本轮未删除表中的任何兼容项。

## 兼容入口、消费者和支持窗口

API 路径均相对于 `/api/agent`。这里的“未声明移除日期”表示没有可据以删除的日历期限；运行记录的保留期与断点接受期限也不构成移除整个适配器的日期。

| 兼容项 | 已核实的消费者或契约 | 当前支持窗口与结论 |
| --- | --- | --- |
| `GET /tasks/status`、`getTaskStatus` | [useBackendStatusMonitor](../client/src/features/runtime-status/hooks/useBackendStatusMonitor.ts)用于首次、focus、online 与周期健康检查；空闲 30 秒、忙时 2 秒，串行安排 | 生产消费者仍在，未声明移除日期，保留。仅检查后端健康；旧 `isRunning` 不作为前端运行状态来源 |
| `GET /schedules/execution`、`getScheduleExecutionStatus` | [automation Query](../client/src/features/automation/model/queries.ts)导出 `scheduleExecutionQueryOptions`；[Dashboard 完整快照](../client/src/features/dashboard/model/queries.ts)仍消费它 | 生产消费者仍在，未声明移除日期，保留。自动化页改用 Run 不代表该投影已无人使用 |
| `stopTask()` 与不带 `runId` 的 `POST /actions/stop` | [task-execution 公开面](../client/src/features/task-execution/index.ts)仍导出 `stopTask`；[API 兼容测试](../client/src/features/task-execution/api/api.test.ts)固定无 body 的旧调用；[服务端路由](../server/routes/agent.js)仍分派到当前执行停止 | 仓库生产前端已无 `stopTask` 调用，但公开契约与旧调用方兼容仍在，未声明移除日期，保留。新调用使用 `stopRun(runId)`，不能把泛化停止替换成目标停止或反过来 |
| schedule 与 copilot-set 的同步执行默认值 | [schedule API](../client/src/features/automation/api/index.ts)省略 `waitForCompletion` 时保持旧同步行为；[copilot API](../client/src/features/combat/api/index.ts)保留可选字段，继续接口默认 `true`；[服务端](../server/routes/agent.js)默认解析为 `true` 并保留旧结果字段 | 未声明移除日期，保留。新的 [automation hook](../client/src/features/automation/hooks/useAutomationExecution.ts)和 [combat hook](../client/src/features/combat/hooks/useCombatExecution.ts)显式传 `false`，由 Run 观察接受后的过程；不能因此改掉旧调用默认值 |
| 作业集 `app` / `cli` 模式别名 | [服务端 normalizeCopilotSetMode](../server/services/agentActionService.js)把缺省、`app`、`cli` 统一成 `continuous`；[combatConfig](../client/src/features/combat/model/combatConfig.ts)仍将服务端与本地持久化旧 `app` 值迁成 UI 的 `cli` | 持久化数据与外部请求的兼容仍在，未声明移除日期，保留。`manual` 独立保留逐关等待语义 |
| `maa-task-flow-execution` 旧断点 | [useAutomationExecution](../client/src/features/automation/hooks/useAutomationExecution.ts)在首份快照后调用 [migrateLegacyFlowCheckpoint](../client/src/features/automation/model/flowCheckpoint.ts)；这是该键唯一生产读取路径 | 接受单条断点的有效期为 24 小时，允许最多 60 秒未来偏差；适配器没有日历移除日期，保留。仅关联已有 Run，绝不重新提交旧任务 |
| 未纳管的 Telegram 流程执行 | [telegramBotService](../server/services/telegramBotService.js)仍直接调用 `schedulerService.executeScheduleNow(flowType, taskFlow)`，没有经过 HTTP 路由的 Run 包装；[runSnapshotService](../server/services/runSnapshotService.js)保留进程、schedule 与 lease 占用投影 | 生产入口仍在，未声明移除日期，保留外部占用识别。没有拥有设备的 Run 时，已观察到的设备活动投影为 `external`，不能认领成当前页面的 Run |

此外，`GET /runs/current` 的快照仍保留顶层旧任务字段，并加入 `run`、`activeRuns`、`lastRun`、`occupancy`；见 [buildAgentRunSnapshot](../server/services/runSnapshotService.js)。新增字段不授权删除旧字段，消费方也不能把一次空快照或观察失败当作成功终态。

## 旧自动化断点的接受与恢复

旧键没有 `runId`，任务列表和本地索引不足以作为执行身份。迁移入口只在 `useAutomationExecution` 当前挂载取得第一份快照后处理一次；它不创建新的执行意图、不恢复页面逐项执行循环。实现与回归分别见 [flowCheckpoint.ts](../client/src/features/automation/model/flowCheckpoint.ts)、[flowCheckpoint.test.ts](../client/src/features/automation/model/flowCheckpoint.test.ts)和[页面执行测试](../client/src/pages/automation/AutomationTasks.execution.test.tsx)。

接受规则：

1. JSON 必须是对象，`version` 缺省或为 `1`，`isExecuting` 必须为 `true`。
2. `tasks` 必须是非空数组，每项至少有非空 `id` 或 `commandId`；可选 `name`、`enabled` 按类型读取。
3. `startTime` 转为数字后必须有限且大于零，不超过当前时间加 60 秒，距当前时间不超过 24 小时。
4. `currentIndex` 转为数字后只有整数且在 `[-1, tasks.length]` 内才保留，否则归一为 `-1`。索引错误不会自动重启任务。

身份关联按快照裁决：

- schedule 正在运行时，必须携带能在快照中找到的 `runId`，且该 Run 是活动的 `run_daily_flow`；缺身份的运行流程按未纳管冲突处理。
- 没有运行中的 schedule 时，优先关联唯一的日常流程活动 Run；多个日常 Run，或匹配身份与当前已跟踪身份不同，按冲突处理。没有日常 Run 而存在其他活动 Run 时，同样按冲突处理。
- 无活动 Run 时，只检查快照的 `lastRun`：它必须是日常流程终态，开始时间不晚于断点时间加 60 秒，完成时间不早于断点时间。不会扫描或推测所有历史执行。
- 成功关联后调用 `observeRun`；活动 Run 继续观察，终态显示结果。无匹配、无效、过期、版本不支持或冲突均给出未重新提交/重新开始的提示。

非空旧键在解析后尝试删除，匹配成功与失败都执行同一清理。存储读取不可用时返回无迁移结果；删除失败通过 `removed: false` 表达，迁移仍只能观察已有 Run，不能因此触发启动或自动重试旧任务。空值按不存在处理。故障恢复应先确认服务端当前占用与身份，再由用户明确开始新的执行，不能通过反复挂载页面来续跑。

[服务端 Run 存储](../server/services/agentRunService.js)按结束时间最多保留 24 小时，并最多保留 500 条终态记录；数量上限可以更早淘汰记录。24 小时是断点接受上限，不能承诺窗口内一定可恢复：对应记录可能已被淘汰，也可能不是快照中的最新终态。无法确认时清理旧断点并提示重新开始，比按本地索引重提更符合执行身份契约。

## 后续移除与回滚规则

兼容项只有同时满足以下条件才能在独立变更中移除：

1. 搜索生产源码、公开导出、脚本、测试、服务端内部调用和已记录的外部消费者，确认已无消费者；测试存在本身不是生产消费者，但能证明仍维护的兼容承诺。
2. 已有明确支持窗口，且窗口确实结束；“未找到移除日期”不能视作窗口结束。对本地持久化格式还需覆盖升级后首次访问及长期未打开页面的用户。
3. 提供替代入口、失效/清理行为及回归证据，并同步 API、配置和生命周期文档。删除公开 API 与删除内部转发分别审计，不能只看当前页面 import。

当前表内各项至少缺少上述一个必要条件，因此保留。后续接入 Telegram 等入口的 Run 包装时，还需证明 schedule、进程与 lease 的真实所有权一致后，再缩减外部占用分支。

回滚前端时应保留服务端 Run 记录、配置草稿与 pending 标记，先观察并确认当前执行；不要为了恢复旧 UI 清空存储、重放启动请求或调用泛化停止。配置完整提交仍可能包含多个请求，不是跨端点事务，schedule 半失败必须保留 pending 并经原协调器重试。执行身份与 Run 继续/停止边界以[执行生命周期](execution-lifecycle.md)为准。

## 验证与性能证据

兼容回归入口包括 task-execution API 测试、自动化旧断点模型与页面执行测试、combat 配置迁移测试，以及服务端路由、Run、快照和作业集测试。依赖/职责护栏负责阻止边界回退；默认态视觉、浏览器交互与性能采样分别验证自己的范围，不能相互替代。

性能对照需使用相同构建、场景和采样协议；方法与限制见[性能采样说明](../client/tests/performance/README.md)。指针拖拽取消与成功保存不是同一种完成语义，普通 production 的 DOM 变化不能报告为 React commit。兼容场景需要各自的行为测试，不能用截图或性能结果代替。
