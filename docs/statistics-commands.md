# 统计识别命令与失效联动

> [← 返回文档索引](README.md)

本文描述 FPR-020 交付的统计数据、识别与材料刷新命令所有者。它回答：仓库/干员识别和设备执行控制器如何接线；识别完成、等待日志可解析、超时、取消和重试分别由谁负责；识别成功后哪些资源失效，以及页面为什么不会因超时或页面生命周期重复执行设备命令。

相关契约：[前端执行客户端与控制器](execution-client.md)、[共享资源归属与失效端口](resource-ownership.md)、[Query 缓存与键规范](query-cache.md)、[资源请求错误与取消契约](resource-requests.md)、[配置同步与资源一致性契约](config-sync-and-invalidation.md)。

## 1. 定位与边界

| 内容 | 唯一归属 | 说明 |
| --- | --- | --- |
| 仓库识别、干员识别、材料刷新的启动与完成条件 | `features/statistics/model/commandOwner.ts` | 非 React 的域内所有者；页面只订阅状态并应用结果 |
| 设备命令提交、幂等键、Run 身份 | `features/task-execution` 控制器 | 识别通过 `beginExecutionIntent('run_task', { scope: 'statistics' })` 提交 |
| 识别日志解析 | `features/statistics/api` 的 `parseDepotData` / `parseOperBoxData` | 解析端点只读 MAA 日志并写本地缓存，不占设备执行租约 |
| 材料刷新脚本 | `features/training/api` 的 `fetchOperatorMaterials` | 不产生 Run；由 statistics 单向调用 |
| 失效发布 | `features/resource-invalidation` | 命令确认成功后发布；失败不发布 |
| Query 缓存 | `features/game-data`、`features/statistics` 的 query 定义 | 识别快照以页面 `setQueryData` 写入，读取仍归 Query |

约束：

- **命令不是 query。** `run-task`、识别解析和材料刷新都不进入 TanStack Query；它们不会被 Query 的自动重试或焦点重取重新提交。
- **等待不是固定延迟。** 识别完成后不等待固定秒数，而是轮询解析端点，直到返回可用快照或超时。
- **命令成功与刷新成功分开。** 设备命令成功只代表可以解析；解析成功才写入快照并发布失效。
- **页面不是命令所有者。** Activity 隐藏、页面卸载和重新挂载都不会重建命令状态、取消等待或重新提交设备命令。

## 2. 命令与完成条件

| 命令 | 端点/任务 | 执行身份 | 完成条件 | 超时（默认） |
| --- | --- | --- | --- | --- |
| 仓库识别 `depot` | `POST /agent/actions/run-task`，`Depot`，`waitForCompletion=true` | `run_task` Run（`scope=statistics`） | 同步响应成功；若响应带活动 Run 则等终态 `succeeded`；随后解析端点返回带 `itemCount` 与 `items` 的快照 | 命令 5min / Run 5min / 解析 30s |
| 干员识别 `operbox` | `POST /agent/actions/run-task`，`OperBox`，`waitForCompletion=true` | 同上 | 同步响应成功；Run 终态成功；解析端点返回带 `operCount` 与 `data` 的快照 | 同上 |
| 材料刷新 `materials` | `POST /agent/actions/fetch-training-materials` | 无 Run（脚本入口） | 响应 `success=true`；材料缓存由服务端刷新 | 5min |

解析端点的成功判定：

- `success=true` 且 `data` 是包含 `itemCount: number`、`items: array`（仓库）或 `operCount: number`、`data: array`（干员）的对象；
- `data: null`、包裹在 `success=true` 内的失败信封、坏载荷与传输失败都视为“结果尚未可用”，在超时前继续轮询，而不是重新执行设备命令；
- 解析请求携带调用方 `AbortSignal`；取消只结束本地等待，不撤销服务端已完成的解析。

## 3. 执行控制器与幂等

识别命令通过控制器的 intent API 提交：

```ts
const intent = executionController.beginExecutionIntent('run_task', {
  scope: 'statistics',
})
const result = await executeCommand(
  'depot',
  [],
  { name: '仓库识别', type: 'Depot', params: { enable: true } },
  signal,
  '仓库识别',
  'statistics',
  true,
  { idempotencyKey: intent.idempotencyKey },
)
executionController.settleExecutionIntent(intent, result)
```

规则：

1. **每个逻辑识别只生成一个幂等键。** 命令超时、本地取消或传输失败后，继续时复用同一个 `idempotencyKey` 再次提交；服务端若已接受会回放已有 Run，不会启动第二个设备命令。
2. **命令确认成功后不再提交。** 等待 Run 终态与解析阶段的中断只恢复等待/解析，`run-task` 不再发送。
3. **活动 Run 只读取。** 幂等回放可能返回仍处于 `accepted`/`running` 的 Run；所有者按 `runId` 读取终态，不重新提交。读取失败不等于执行失败，超时前继续观察。
4. **本地中止不是停止。** 取消超时只 `AbortController.abort()` 当前请求；不调用 `stopTrackedRun`，服务端执行与设备状态不受影响。
5. **定终态才结束。** `failed`/`interrupted`/`stopped` 不解析、不发布；`succeeded` 或无 Run 身份的旧同步响应才进入解析。

## 4. 超时、取消与继续

所有者状态：

| 阶段 | 含义 |
| --- | --- |
| `running` | `run-task` 或材料刷新请求在途（含幂等回放确认） |
| `waiting` | 命令已接受，等待 Run 终态 |
| `parsing` | 轮询识别解析端点，等待日志可解析 |
| `succeeded` / `failed` | 终态 |
| `timed-out` / `cancelled` | 本地等待结束，可能仍可继续 |

继续方式：

| 中断点 | `resumeMode` | 继续时的动作 | 是否重新执行设备命令 |
| --- | --- | --- | --- |
| 命令超时、取消或传输失败 | `command` | 复用同一幂等键确认已有 Run；若首次请求未到达则只执行一次 | 否（幂等回放） |
| Run 终态等待超时/取消 | `parse` | 按 `runId` 继续读取终态，再解析 | 否 |
| 解析超时/取消 | `parse` | 只重新轮询解析端点 | 否 |
| 材料刷新超时/取消 | `null` | 没有 Run 身份可确认；用户主动重试是一次新的显式操作 | 是（仅用户显式触发） |

页面对 `resumeMode=parse` 的按钮显示“继续解析”，对 `resumeMode=command` 显示“重试识别”；`failed` 且不可继续时恢复“立即执行”。所有者本身不自动重试任何阶段。

## 5. 识别成功后的失效联动

命令确认成功且解析完成后，由所有者发布一次失效（`cause: 'recognition'`）：

| 命令 | 作用域 | 接收方结果 |
| --- | --- | --- |
| 仓库识别 | `depot`、`materials`、`training-queue`、`dashboard-snapshot` | 统计页按 `depot` 失效并重读；养成页重读队列/候选/计数并作废旧计划；总览走完整快照刷新 |
| 干员识别 | `operbox`、`materials`、`training-queue`、`dashboard-snapshot` | 统计页按 `operbox` 失效；养成页与总览同上 |
| 材料刷新 | `materials`、`training-queue`、`dashboard-snapshot` | 养成页重读候选/队列并作废旧计划；总览刷新；统计页不再额外重读目录 |

规则：

- **写成功才发布。** 命令失败、Run 失败、解析失败与超时都不发布。
- **快照是权威结果。** 页面把解析出的完整快照写入 `game-data` 的 `depot`/`operbox` key；跨域接收方各自刷新，不复制页面副本。
- **发布自身资源会带来一次后台重读。** 统计页订阅 `depot`/`operbox`，收到自己发布的失效后会按默认 Query 策略重取一次；服务端此时已保存解析结果，因此不会用旧快照覆盖新结果。若页面在 Activity 隐藏期间完成，恢复时由失效 hook 补发一次并重取。
- **材料刷新不再触发目录重读。** 干员目录端点不包含材料进度；材料刷新的影响由 `materials` 作用域表达，养成页据此重读候选与计数。

## 6. 页面与生命周期

- `StatisticsWorkspace` 通过 `hooks/useStatisticsCommands.ts` 订阅一次命令状态：`isRunning`、当前任务、按钮 loading 与 resume 文案都从同一份 `useStatisticsCommandState()` 快照派生；干员/仓库面板只接收该投影，不再各自维护 `isRunning`/`activeTask`。
- 命令所有者是模块级单例，寿命不跟随页面。Activity 隐藏会清理页面 Effects，但不会中止所有者；页面重挂载时按钮仍显示进行中，不会重复提交。
- 点击处理器在 Activity 隐藏后仍会继续完成；解析成功时会把快照写入应用级 QueryClient，因此隐藏期间完成也不会丢失权威快照。
- 所有者不持有服务端资源副本；页面与 Query 仍按 [Query 缓存与键规范](query-cache.md) 读取和失效。
- 命令状态不写入 Zustand、localStorage 或 URL；跨刷新恢复的是服务端 Run 身份（由执行控制器持久化），不是识别命令本身。刷新后不会自动重新发起识别。

## 7. 兼容与回滚

- `parseDepotData`、`parseOperBoxData`、`fetchOperatorMaterials` 新增可选末位 `AbortSignal`；原有调用与响应形状不变。识别端点仍是 POST，解析仍只读本地日志。
- 识别命令的请求参数、任务类型、端点与快照形状保持不变；服务端数据格式未变。
- 行为变化：移除命令成功后的固定 2s 等待，改为解析可用性轮询；不再为提示文案读取一次养成队列；材料刷新后不再重读干员目录（目录不含材料数据）。这些都在命令所有者范围内，不改变页面布局。
- 独立回滚本任务提交会恢复页面内联命令与固定等待；服务端 Run、幂等键和失效端口协议保持兼容，不需要数据迁移。
- 超时值是可注入的域内常量，生产默认值见第 2 节；没有暴露为用户设置。

## 8. 回归证据

| 文件 | 覆盖 |
| --- | --- |
| `features/statistics/model/commandOwner.test.ts` | 控制器 intent/幂等键、仓库与干员快照、材料刷新、单飞、解析轮询、解析超时后继续不重提、命令超时后复用同一幂等键并等待回放 Run、失败/拒绝、取消后继续 |
| `features/statistics/pages/DataStatistics.layout.test.tsx` | 页面订阅命令状态、识别快照写入 Query、`depot`/`operbox`/`materials` 失效事件、按作用域失效、运行中不重复提交、超时后“继续解析”不重执行、Activity 隐藏/恢复 |
| `features/statistics/components/FilterMenu.test.tsx`、`components/DropPanel.test.tsx` | FPR-032 面板化后的筛选菜单 portal/焦点/键盘，以及非当前 tab 仍启动读取、周期切换与重试 |
| `features/statistics/api/index.test.ts` | 解析端点的 signal 与 POST 形状；既有掉落/开放关卡读取 |
| `features/training/api/index.test.ts` | 材料刷新脚本的 signal 与 POST 形状 |
| `features/training/pages/OperatorTraining.test.tsx` | `materials`/`depot`/`operbox` 失效后重读队列、候选与计数并作废旧计划 |
| `features/dashboard/pages/Dashboard.test.tsx` | `dashboard-snapshot` 失效触发完整快照刷新，单路失败保留旧快照 |
| `features/resource-invalidation/hooks/useResourceInvalidation.test.tsx` | Activity 隐藏期间错过发布后的恢复补发 |

针对性命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client exec vitest run \
  src/features/statistics \
  src/features/resource-invalidation \
  src/features/training/api/index.test.ts \
  src/features/training/pages/OperatorTraining.test.tsx \
  src/features/dashboard/pages/Dashboard.test.tsx
```

## 关联

- [前端执行客户端与控制器](execution-client.md)：intent、幂等键、Run 身份与本地中止。
- [共享资源归属与失效端口](resource-ownership.md)：作用域词汇、发布规则与接收端。
- [Query 缓存与键规范](query-cache.md)：识别快照写入与失效后的缓存行为。
- [资源请求错误与取消契约](resource-requests.md)：解析与材料的 signal、失败分类。
