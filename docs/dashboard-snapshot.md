# 总览完整快照与设备采样

> [← 返回文档索引](README.md)

本文描述 FPR-030 交付的总览数据所有权：五路业务读取如何组合成一份完整快照、单路失败如何保留上一份结果、设备采样如何独立轮询与恢复，以及总览如何接收获批的领域失效与统一执行入口。

相关契约：[Query 缓存与键规范](query-cache.md)、[配置同步与资源一致性契约](config-sync-and-invalidation.md)、[共享资源归属与失效端口](resource-ownership.md)、[前端执行客户端与控制器](execution-client.md)、[资源请求错误与取消契约](resource-requests.md)。

## 1. 定位与边界

| 内容 | 唯一所有者 | 说明 |
| --- | --- | --- |
| 当前活动、定时执行状态 | `features/automation/model/queries.ts` | `automation/activity`、`automation/schedule-execution` 只读资源 |
| 养成队列 | `features/training/model/queries.ts` | `training/queue`，与养成页共享同一缓存身份 |
| 今日掉落、今日开放关卡 | `features/statistics/model/queries.ts` | `statistics/today-drops`、`statistics/open-stages` |
| 完整业务快照的读取与原子提交 | `features/dashboard/model/queries.ts`、`model/snapshotRefresher.ts` | 五路全部有效才提交；单路失败保留旧快照 |
| 快照形状与归一 | `features/dashboard/model/snapshot.ts` | 纯函数，不发起请求、不读写 store |
| 展示投影与持久化缓存 | `features/dashboard/store/dashboardStore.ts` | `la-pluma-dashboard-cache` v1；只由完整快照持久化 |
| 设备采样 | `features/device-mirror/model/queries.ts`、`hooks/useDeviceStatsSample.ts` | `device-mirror/device-stats`，5s 轮询，独立失败策略 |
| 设备采样写入总览 | `features/dashboard/hooks/useDashboardDeviceStats.ts` | 每条成功样本交给 store 做语义校验与温度历史；同一 `dataUpdatedAt` 的缓存回放只追加一次（FPR-040） |
| 后端连接探针 | `features/runtime-status` | 不参与五路业务快照的有效性判定 |
| 日常/活动启动 | `features/dashboard/hooks/useDashboardExecution.ts` | 经应用级 task-execution 控制器提交，`scope: 'dashboard'` |

约束：

- **完整快照不是五个可独立展示的资源块。** 不得让五个 `useQuery` 各自写 `dashboardStore`，也不得把 Query 的逐块更新当成新的可写真相。
- **`dashboard/snapshot` 只用于协调读取。** 它的缓存不承担展示或持久化：`staleTime: 0`、`gcTime: 0`，成功后立即由 `dashboardStore` 原子提交。
- **设备采样与业务快照相互独立。** 采样失败不影响业务快照；业务刷新失败也不清除最新样本。

## 2. 五路读取与归一

`readDashboardSnapshot(client)` 并发读取五个领域 Query：

| 资源 | Query key | 读取 |
| --- | --- | --- |
| 当前活动 | `['automation','activity','Official']` | `getActivity('Official', signal)` |
| 定时执行状态 | `['automation','schedule-execution']` | `getScheduleExecutionStatus(signal)` |
| 养成队列 | `['training','queue']` | `getTrainingQueue(signal)` |
| 今日掉落 | `['statistics','today-drops']` | `getTodayDrops(signal)` |
| 今日开放关卡 | `['statistics','open-stages']` | `getOpenTodayStages(signal)` |

每路都显式 `staleTime: 0` 且 `retry: false`：总览每次刷新都读取最新值；单路失败由下个周期或失效入口重试，不在协调层叠加自动重试。

`normalizeDashboardSnapshot` 负责兼容与校验：

- activity 必须是对象且 `completion` 形状合法；支持 `isActive`、`available`、`code`/`id`、`name`/`displayName`/`stageName` 等既有字段。
- schedule execution 必须是对象；`isRunning`/`running`/`executing` 归一为运行态，`lastResult`/`result`/`lastMessage` 走既有摘要格式化。
- training queue 接受数组或 `{ queue }`；drops 接受数组或 `{ records }`；open-today 必须是 `{ open, closed }`，两组均为 `{ stage, name }` 数组（每组最多 100 项）。
- 任一载荷缺失、形状不符或 completion 越界时返回 `null`；协调器不会提交部分结果。

## 3. 原子提交与失败策略

`dashboardSnapshotRefresher`（模块级单例）负责刷新节奏：

1. **单飞**：同一时刻只有一个协调读取；非 `force` 调用复用同一 promise。
2. **force 补一次**：`force` 在在途读取结束后再补一次，覆盖“读取过程中收到失效”的情况。
3. **后端探针不否决快照**：`probeBackendAvailability` 与五路并发，失败只影响连接健康展示；五路业务读取本身已证明后端可达。
4. **离线上报尝试**：浏览器离线时不发业务请求，但仍记录本次尝试并结束刷新。
5. **原子提交**：只有 `readDashboardSnapshot` 返回完整快照时调用 `dashboardStore.finishRefresh(attemptedAt, snapshot)`；失败调用无快照版本，保留旧业务值、旧 `lastUpdate` 与已持久化的完整缓存，只更新 `lastRefreshAttemptAt`。
6. **预期失败静默**：`ApiRequestError`（API/contract/transport）与取消不写入控制台错误；只有未知异常记录，保持迁移前“单路失败保旧”的安静行为。

`dashboardStore` 仍执行第二道形状校验；非法快照不会覆盖缓存。完整快照提交时合并当前设备样本与温度历史，并写入 `la-pluma-dashboard-cache` v1。

## 4. 设备采样

- Query key：`['device-mirror','device-stats']`；`deviceStatsQueryOptions` 把 Query 的 `signal` 传给 `/agent/device-stats`。
- `useDeviceStatsSample` 是页面观察入口：`refetchInterval: 5s`、`staleTime: 0`、`refetchOnMount: 'always'`、`retry: false`。轮询本身已按 5s 重试，不叠加默认 Query 重试。
- 采样失败静默保留上一份成功数据；`data: null`（无设备）不覆盖旧样本。非法字段（百分比越界、非有限数值、形状错误）由 `dashboardStore.updateDeviceStats` 拒绝，不污染缓存或温度历史。
- 每次新的成功采样都会追加一个温度点（依赖 `dataUpdatedAt`，即使数值相同也不丢点），最多保留 36 个；同一份缓存样本在 Activity 恢复重跑 Effect 时不会重复追加（FPR-040 按 `dataUpdatedAt` 与样本身份去重）。样本本身不单独写 localStorage，随下一次完整业务快照提交一起持久化。
- Activity 隐藏/卸载会注销 Query 观察者并清理 5s 计时器；恢复时 `refetchOnMount: 'always'` 立即采样一次，再只建立一个周期计时器。文档隐藏时 Query 默认暂停后台轮询，可见后恢复。
- 设备采样不参与完整快照有效性，也不在 `dashboardStore` 中维护第二份可写资源。

## 5. 刷新调度、失效与恢复

`useDashboardSnapshotRefresh` 是页面的唯一同步入口：

- 首屏无缓存或距 `lastRefreshAttemptAt` 满 5 分钟时刷新，否则只安排下一次；刷新完成后串行安排下一轮。
- 订阅 `dashboard-snapshot` 作用域：收到计划应用、识别完成、队列变更、资源/热更新等已批准的发布会 `force` 刷新；发布端仍按[共享资源归属与失效端口](resource-ownership.md)第 5 节列举作用域。
- Activity 隐藏时清理计时器与失效订阅；恢复时若期间有发布，`useResourceInvalidation` 补发一次 `activity-resume`，触发一次完整刷新。真正卸载后重挂载按首屏/新鲜度规则重新读取。
- 网络恢复（`online` 事件）`force` 刷新。
- 在途协调读取不因 Activity 隐藏中止；结果仍写入 store，隐藏期间完成的快照在恢复后直接可用。

统一执行入口保持 FPR-011 的接线：`useDashboardExecution` 调用 `executionController.submitExecution`，日常流程使用 `run_daily_flow` 与 `scope: 'dashboard'`，活动预检使用 `run_current_activity_copilots`。操作成功后的刷新仍走 `refreshDashboard`（force），不另建页面请求路径。FPR-040 起该接线由 `DashboardFlowPanel` 经 `useDashboardFlowActions` 调用，刷新调度仍只有页面/工作区一份，语义不变（见[总览领域面板](dashboard-panels.md)）。

## 6. 缓存与持久化边界

| 数据 | 位置 | 生命周期 |
| --- | --- | --- |
| 五路资源读取 | 各自领域 Query 缓存 | 默认 30s 新鲜期；总览协调读取显式 `staleTime: 0` |
| 协调快照 | `dashboard/snapshot` | `gcTime: 0`，不长期保留 |
| 展示快照 | `dashboardStore` | 进程内；完整快照才更新 `lastUpdate` |
| 持久化快照 | `la-pluma-dashboard-cache` v1 | 仅完整快照提交时写入；恢复校验版本/形状/语义边界/未来时钟偏差 |
| 设备样本 | `device-mirror/device-stats` Query + `dashboardStore` | 内存；不单独持久化，随完整快照夹带 |

## 7. 兼容与已知行为差异

- 端点、响应信封、`la-pluma-dashboard-cache` v1 与 store 字段未变；回滚本项即恢复页面内请求编排，不需要数据迁移。
- 五路读取继承资源 Query 的信封/载荷校验与 `signal`；总览协调读取显式关闭自动重试，失败路径仍为一次请求后保留旧快照（迁移前不自动重试）。
- 设备轮询在文档隐藏时暂停，恢复可见后立即采样；迁移前每 5s 固定请求。轮询失败仍是静默保旧，不展示错误。
- 设备采样不再由 Dashboard 页面直接轮询；`updateDeviceStats` 接受未知载荷并在 store 内校验，避免把端点形状当成可信类型。
- Activity 恢复不再直接调用页面私有计时器；计时器由 Query 观察者与同步 hook 各自管理，隐藏时全部清理。
- `AutomationTasks` 仍按页面配置流程直接调用 `getActivity`；该调用不写 Query 缓存，`automation/activity` 目前由总览快照读取，自动化页的读取迁移留给 FPR-037/FPR-039。`schedule-execution` 只由总览使用。

## 8. 回归证据

| 文件 | 覆盖 |
| --- | --- |
| `client/src/features/dashboard/model/snapshot.test.ts` | 五路归一、兼容载荷、各字段回退、单路缺失/形状错误/越界返回 `null` |
| `client/src/features/dashboard/model/queries.test.ts` | 五个领域 key 与 signal、协调快照 key/缓存参数、每次重读、单路失败与坏载荷整体失败、不继承自动重试 |
| `client/src/features/dashboard/model/snapshotRefresher.test.ts` | 单飞、force 补一次、原子提交、失败保旧、探针不否决、离线、预期失败静默 |
| `client/src/features/dashboard/hooks/useDashboardDeviceStats.ts`（页面用例） | 首次设备样本投影到 store 与温度历史；FPR-040 起由 `useDashboardDeviceStats.test.tsx` 覆盖 Activity 恢复去重 |
| `client/src/features/dashboard/hooks/useDashboardDeviceStats.test.tsx` | 首次投影、Activity 恢复不重复追加、新时间戳追加、null 载荷保旧 |
| `client/src/features/dashboard/model/flowView.test.ts` | 流程卡命令文案、按钮状态与禁用规则的纯投影 |
| `client/src/features/dashboard/model/deviceView.test.ts` | 使用率阈值与温度曲线几何 |
| `client/src/features/dashboard/components/DashboardFlowSection.test.tsx` | 预览入口随 Activity 隐藏/恢复保留与导航回调 |
| `client/src/pages/dashboard/Dashboard.test.tsx` | 完整快照原子提交、单路失败/形状错误保旧、计划应用/识别/资源更新失效、Activity 隐藏期间失效恢复、设备样本投影、预检不写快照、启动后经协调器刷新、预览挂载与导航、启动入口与控制器身份 |
| `client/src/features/device-mirror/model/queries.test.ts` | 设备 key、signal、null 载荷与失败信封 |
| `client/src/features/device-mirror/hooks/useDeviceStatsSample.test.tsx` | 5s 轮询、失败保旧、null 不覆盖、Activity 隐藏停轮询、恢复立即采样且只有一个计时器 |
| `client/src/features/automation/model/queries.test.ts` | activity/schedule-execution key、clientType 参数、signal 与失败 |
| `client/src/features/statistics/model/queries.test.ts` | today-drops/open-stages key、signal、失败信封 |
| `client/src/features/dashboard/store/dashboardStore.test.ts` | 缓存版本/形状/时钟偏差/语义边界、设备样本合并与温度点去重、失败刷新不覆盖成功缓存 |

针对性命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client exec vitest run \
  src/features/dashboard \
  src/features/device-mirror \
  src/features/automation/model \
  src/features/statistics/model
```

完整 `pnpm --filter la-pluma-next-client verify` 与 `pnpm visual` 由任务完成记录给出；本文件不重复声称未执行的验证。

## 关联

- [前端职责与质量基线](frontend-baseline.md)：Dashboard 的职责与 Activity 说明。
- [资源请求错误与取消契约](resource-requests.md)：signal、失败分类与载荷校验。
- [Query 缓存与键规范](query-cache.md)：默认策略、key 规范与已迁移资源。
- [共享资源归属与失效端口](resource-ownership.md)：写入方的失效发布与订阅规则。
- [前端执行客户端与控制器](execution-client.md)：Dashboard 启动入口与 `scope`。
