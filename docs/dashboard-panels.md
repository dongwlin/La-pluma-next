# 总览领域面板

> [← 返回文档索引](README.md)

本文说明总览页面组合与按区域订阅。五路业务快照、设备采样、执行控制器与失效协调的所有者均未改变；区域容器分别持有局部订阅与展示计算。

相关契约：[总览完整快照与设备采样](dashboard-snapshot.md)、[前端执行客户端与控制器](execution-client.md)、[Query 缓存与键规范](query-cache.md)、[共享资源归属与失效端口](resource-ownership.md)、[前端架构与所有权](frontend-architecture.md)。

## 1. 定位与边界

| 内容 | 唯一归属 | 说明 |
| --- | --- | --- |
| 页面壳、首屏门禁、页头与全局状态指示 | `pages/dashboard/Dashboard.tsx` | 未加载时返回完整骨架；加载后组合工作区；只订阅 `hasLoaded` 并持有唯一的 `useDashboardSnapshotRefresh` |
| 区域组合与导航回调 | `features/dashboard/components/DashboardWorkspace.tsx` | 组合连接提示、流程、设备与摘要区域；创建“打开自动化/养成/数据”三个回调 |
| 设备采样投影 | `DashboardWorkspace` 内的 `DashboardDeviceSampleProjection` | 只调用一次 `useDashboardDeviceStats`，返回 `null`；样本更新不推动兄弟区域重渲染 |
| 连接健康提示与重试 | `features/dashboard/components/DashboardConnectionAlert.tsx` | 离线/后端不可用时渲染；重试调用完整快照协调器 |
| 流程区域（网格与预览入口） | `features/dashboard/components/DashboardFlowSection.tsx` | `useDashboardFlowLayout` 的网格测量与预览壳；预览入口始终挂载 |
| 今日流程卡 | `features/dashboard/components/DashboardFlowPanel.tsx` | 订阅活动/定时/开放关卡摘要；持有预检/启动反馈 |
| 流程操作入口 | `features/dashboard/hooks/useDashboardFlowActions.ts` | 组合 `useDashboardExecution` 与刷新回调；不写 store、不另发请求 |
| 连接健康投影 | `features/dashboard/hooks/useDashboardServiceStatus.ts` | 把 `backendStatus` 与在线状态映射成文案；探针仍归 `runtime-status` |
| 设备状态区域 | `features/dashboard/components/DashboardDeviceSection.tsx` | 只订阅 `deviceStats` 与 `temperatureHistory`；无样本时不渲染 |
| 摘要区域 | `components/DashboardSummarySection.tsx` | 养成与掉落卡片常驻 |
| 养成摘要卡 / 掉落摘要卡 | `components/DashboardTrainingSummaryCard.tsx`、`DashboardDropSummaryCard.tsx` | 各自订阅自己的摘要切片与导航函数 |
| 流程展示计算 | `features/dashboard/model/flowView.ts` | 纯函数：命令标题/说明、按钮文案、禁用与忙碌标记 |
| 设备展示计算 | `features/dashboard/model/deviceView.ts` | 纯函数：使用率颜色语义与温度曲线几何 |
| 完整快照协调 | `model/snapshotRefresher.ts` + `hooks/useDashboardSnapshotRefresh.ts` | 由此工作区接入，保持完整快照协调唯一性 |
| 设备采样轮询 | `device-mirror` 的 `useDeviceStatsSample` | 已实现；轮询间隔、暂停与失败保旧保持不变 |
| 预览会话 | `components/DashboardPreviewEntry.tsx` + `device-mirror` | 已实现；遵循已有预览协议 |

维护约束：

- 不改变五个领域 Query key、`staleTime`/`gcTime`、自动重试、失效作用域与 5 分钟刷新节奏。
- 不改变执行端点、幂等键、`scope: 'dashboard'`、预检响应语义与终态提示规则。
- 不改变设备采样端点、5s 间隔、文档隐藏暂停、`refetchOnMount: 'always'` 与失败保旧。
- 不改变 `la-pluma-dashboard-cache` v1 的字段或持久化条件；`lastDeviceSampleAt` 只是运行期去重标记，不写入 localStorage。
- 不把预检 loading、启动反馈、流程展示计算写入 `dashboardStore`、Query、localStorage 或 URL。
- 不改变渲染结构、DOM/CSS 类名、文案或默认态视觉；既有 DOM/CSS 与视觉约束保持不变。
- 总览没有展开/折叠交互；没有跨面板展开状态需要提升为共享状态。局部交互状态只有预检/启动 loading 与反馈，就近放在流程卡。

## 2. 组合与订阅边界

```
Dashboard（首屏门禁、页头、唯一刷新调度）
└─ DashboardWorkspace（区域组合 + 导航回调）
   ├─ DashboardDeviceSampleProjection（采样投影，返回 null）
   ├─ DashboardConnectionAlert（连接健康 + 重试）
   ├─ DashboardFlowSection（网格测量 + 预览入口）
   │  ├─ DashboardFlowPanel（执行/预检/摘要 + flowView）
   │  └─ DashboardPreviewEntry（device-mirror 预览会话）
   ├─ DashboardDeviceSection（deviceStats + temperatureHistory）
   └─ DashboardSummarySection
      ├─ DashboardTrainingSummaryCard（trainingSummary）
      └─ DashboardDropSummaryCard（dropSummary）
```

- **刷新只有一个调度。** `Dashboard` 调用一次 `useDashboardSnapshotRefresh()`；流程卡与连接提示通过 `refreshDashboard` prop 复用同一协调器。区域不创建计时器、失效订阅或第二套读取。
- **设备采样投影只有一个实例。** `DashboardDeviceSampleProjection` 在执行采样 hook 后返回 `null`，因此每 5s 的 Query 数据变化只重渲染这个空组件，不推动流程、摘要或连接区域。采样本身仍由 device-mirror 的 Query 观察者持有。
- **执行只有一个订阅。** `DashboardFlowPanel` 通过 `useDashboardFlowActions` 调用一次 `useDashboardExecution`；连接提示、设备与摘要区域不订阅执行快照。
- **摘要按卡片订阅。** 养成摘要更新只重渲染 `DashboardTrainingSummaryCard`，掉落摘要更新只重渲染 `DashboardDropSummaryCard`；摘要区域自身没有订阅。
- **连接健康只影响使用它的区域。** `DashboardConnectionAlert` 与流程操作 hook 各自读取 `useDashboardServiceStatus`；后端状态或在线状态变化不会重渲染设备与摘要区域。
- **导航回调只创建一份。** 工作区用同一 `navigate` 创建自动化/养成/数据回调，流程卡与摘要卡只接收函数，不直接依赖路由。
- 面板可调用所属领域 hook；流程展示与设备展示的规则留在纯模型，组件只负责渲染。

订阅隔离（渲染边界的验收依据）：

| 状态变化 | 会重渲染 | 不会重渲染 |
| --- | --- | --- |
| 活动/定时/开放关卡快照提交 | `DashboardFlowPanel` | 设备、摘要、连接提示 |
| 预检/启动 loading 或流程反馈 | `DashboardFlowPanel` | 设备、摘要、连接提示 |
| 执行控制器快照（运行/停止/占用） | `DashboardFlowPanel` | 设备、摘要、连接提示 |
| 设备样本（每 5s） | `DashboardDeviceSampleProjection`、`DashboardDeviceSection`（仅在有样本时） | 流程、摘要、连接提示 |
| 养成摘要 | `DashboardTrainingSummaryCard` | 掉落卡、流程、设备、连接提示 |
| 掉落摘要 | `DashboardDropSummaryCard` | 养成卡、流程、设备、连接提示 |
| 后端状态 / 在线状态 | `DashboardConnectionAlert`、`DashboardFlowPanel` | 设备、摘要 |

页面不再整体订阅状态消息：流程卡从 `useStatusStore` 只取 `setMessage` 动作，因此成功/警告消息不会重渲染总览工作区。全局状态指示器仍自行订阅消息。

## 3. 今日流程入口与预检

`useDashboardFlowActions` 保留迁移前的用户路径，只把接线移到区域附近：

| 操作 | 行为 | 领域所有者 |
| --- | --- | --- |
| 开始今日流程 | 校验在线/后端可用 → `loadUserConfig('automation-tasks')` → 空流程时提示并导航自动化 → `startFlow(flow)` 经控制器提交 `run_daily_flow` | `user-config` 读取 + `task-execution` 控制器 |
| 启动成功后的刷新 | `await refreshDashboard()`（`force` 完整快照） | `dashboardSnapshotRefresher` |
| 打当前活动 | 同步调用 `/agent/activity/run`；只有 `executed=true` 才刷新 | `task-execution` 控制器 + automation 域端点 |
| 设备忙/提交在途 | 按钮禁用或返回 warning；同一时刻只允许一次提交 | 控制器 `submission` + 区域在途 ref |

- `quickStartLoading`、`activityPreflightLoading` 与反馈只存在于流程区域；预检期间不读取五路资源、不调用 `finishRefresh`，因此不会产生半份快照或提前更新时间戳。
- 成功启动或实际执行活动后才经协调器刷新；刷新失败仍由协调器保留旧完整快照。
- 终态提示与运行/占用/未知阶段仍来自 `useDashboardExecution` 的唯一控制器快照；流程卡只增加展示投影。
- 未保存流程时导航到自动化页的行为、提示文案与警告类型与迁移前一致。

## 4. 设备采样与温度历史

- 采样观察者由 `device-mirror` 的 `useDeviceStatsSample` 持有；间隔和 Query 参数见[Query 缓存与键规范](query-cache.md)。文档隐藏时暂停后台轮询，Activity 隐藏/恢复注销与重建观察者。
- `useDashboardDeviceStats` 把成功样本连同 `dataUpdatedAt` 交给 `dashboardStore.updateDeviceStats`；store 继续做百分比、有限数值与形状校验，并维护最多 36 个温度点。
- **样本身份去重。** Activity 隐藏会清理 Effects，恢复时重跑同一份 Query 缓存样本。`updateDeviceStats(stats, dataUpdatedAt)` 在以下情况不追加温度点：时间戳早于最近样本；或时间戳相同且样本对象与 store 中保存的是同一份缓存对象。新的 `dataUpdatedAt` 始终追加一次，即使温度数值相同；同一毫秒内产生了不同样本对象时也按新样本处理。
- `lastDeviceSampleAt` 只存在于运行期 store，不进入 `la-pluma-dashboard-cache`；刷新页面后从持久化快照恢复旧温度历史，并由新采样继续追加。
- 没有设备（`data: null`）、轮询失败或非法字段都不会清除上一份成功样本或温度历史。
- 采样投影随工作区在页面脱离骨架后挂载；骨架阶段没有设备区域，因此可见结果不变。采样间隔、暂停与失败策略未变。

## 5. 预览生命期

- `DashboardPreviewEntry` 始终渲染在流程网格的预览壳内，不按流程 loading、执行阶段、连接健康或设备样本条件卸载；网格测量依赖它提供的 `[data-dashboard-preview-card]` 与 `[data-dashboard-preview-frame]`。
- 预览会话仍由 device-mirror 的 `usePreviewSession`/`usePreviewSnapshot` 持有：Activity 隐藏会清理连接与截图 Effects，保留所选模式；恢复时按所选模式重建。文档隐藏暂停不影响业务快照。
- 点击预览画面仍导航到自动化页的完整控制台；该回调与“未保存流程”共用工作区提供的导航函数。
- 区域测试只验证流程区域不条件卸载预览入口；真正的连接/截图生命周期仍由 device-mirror 的预览测试覆盖。

## 6. 局部展示计算

`model/flowView.ts` 的 `buildDashboardFlowView` 输出：

| 输出 | 规则 |
| --- | --- |
| `isRunning` | `phase` 为 `running`/`waiting` |
| `controlsDisabled` | 任一 loading、设备忙或后端不可用 |
| `statusLabel` | 有活动 run 时为“当前任务”；否则 loading 时为“当前操作”；否则“运行状态” |
| `commandTitle` | 不可用 → 连接标题；预检/启动 loading → 对应进行中文案；再按 `waiting`/`running`（标签 → 当前任务 → 默认）/`occupied`/`unknown`/`idle` 回退 |
| `commandDescription` | 不可用 → 连接说明；loading → 对应说明；再按阶段回退到运行说明、计划消息或待命文案 |
| `primaryActionLabel` / `statusKey` | `waiting` → “等待继续”；运行 → “正在运行”；否则“开始今日流程”；loading 时状态为 `starting` |

`model/deviceView.ts` 的规则：

| 导出 | 规则 |
| --- | --- |
| `getUsageTone` | `null`/`<75` → normal；`>=75` → warning；`>=90` → danger |
| `buildTemperatureSeries` | 空历史返回 `null`；单点复制为水平线；稳定区间（最大值−最小值 `<0.1`）增加 ±1 纵向余量；`y = 25 − ((value − chartMin) / spread) × 18`；“近 N 秒”至少显示 5 秒 |

这两个模块不访问 React、Query、store 或网络，可用纯 Node 测试覆盖。

## 7. Activity 与卸载

| 状态 | 所有者 | Activity 隐藏 / 恢复 | 真正卸载 / 刷新 |
| --- | --- | --- | --- |
| 完整业务快照与 `lastRefreshAttemptAt` | `dashboardStore` + 协调器 | 页面的刷新计时器与失效订阅清理；在途协调读取继续并原子提交；恢复按时间戳决定刷新 | 从 `la-pluma-dashboard-cache` v1 恢复，再按 5 分钟规则刷新 |
| 预检/启动 loading 与反馈 | `DashboardFlowPanel` 本地状态 | 保留；显示时继续可见 | 重置 |
| 执行订阅与终态提示 | `task-execution` 控制器 + `useDashboardExecution` | 观察者随 Effects 重建，控制器继续观察；不发送停止 | 按持久化身份恢复，不重新提交 |
| 设备采样 | `device-mirror/device-stats` Query | 观察者注销、计时器清理；恢复立即采样一次；缓存回放不重复追加温度点 | 新 Query 立即读取；持久化温度历史保留 |
| 设备温度历史 | `dashboardStore` | 保留 | 随完整快照缓存恢复 |
| 摘要与当前活动 | `dashboardStore` | 保留 | 随完整快照缓存恢复 |
| 预览会话 | `device-mirror` | 清理连接/截图 Effects，保留模式；恢复按模式重建 | 按 `autoStart` 规则恢复模式 |
| 导航回调 | `DashboardWorkspace` | 稳定 | 重建 |

## 8. 兼容与维护约束

- 保持端点、响应信封、`la-pluma-dashboard-cache` v1、store 字段与 DOM/CSS 兼容；Query key 与默认策略以[Query 缓存与键规范](query-cache.md)为准。
- 行为变化：
 1. **温度点去重（缺陷修复）。** 迁移前 `useDashboardDeviceStats` 在 Activity 恢复重跑 Effect 时会把缓存中的同一份样本再追加一次，随后立即采样又追加一次，导致“近 N 秒”偏大。现在同一 `dataUpdatedAt` 的缓存回放只记录一次；新采样仍逐次追加。相关回归见 `useDashboardDeviceStats.test.tsx` 与 store 测试。
  2. **设备采样投影的启动时机。** 投影从页面顶层移到工作区（页面脱离骨架后）。骨架阶段没有设备区域，可见行为不变；采样间隔、暂停与失败保旧未变。
  3. **状态消息不再重渲染页面。** 流程卡只从 `useStatusStore` 取 `setMessage` 动作，总览不再因全局消息正文整体重渲染；显示内容与计时器仍由 `statusStore` 决定。
  4. **执行订阅随工作区挂载。** 首屏骨架期间不再建立流程卡的执行订阅；骨架期间完成的 run 不产生页面内终态提示，全局运行投影仍独立展示。页面正常装载后的观察、身份与提示规则不变。

## 9. 回归测试

| 文件 | 覆盖 |
| --- | --- |
| `model/flowView.test.ts` | 空闲/运行/等待/占用/未知/不可用/loading 的命令文案、按钮状态与禁用规则 |
| `model/deviceView.test.ts` | 使用率阈值、空历史、单点水平线、稳定区间、曲线几何与时长文案 |
| `hooks/useDashboardDeviceStats.test.tsx` | 首次投影、Activity 恢复不重复追加、新时间戳追加、`null` 载荷保旧 |
| `components/DashboardFlowSection.test.tsx` | 预览入口随 Activity 隐藏/恢复保留、效果重建、预览点击导航回调 |
| `pages/dashboard/Dashboard.test.tsx` | 首屏/缓存/后台刷新、四类失效、单路失败保旧、预检不写快照、启动后经协调器刷新、空流程导航、执行投影、Activity 恢复、预览挂载、导航与设备投影 |
| `store/dashboardStore.test.ts` | 温度点去重、时间戳不持久化、既有缓存形状/时钟偏差/设备样本合并 |
| `model/queries.test.ts`、`model/snapshot.test.ts`、`model/snapshotRefresher.test.ts` | 既有五路读取、归一、原子提交与失败策略 |
| `device-mirror` 的 Query/采样/预览测试 | 采样间隔、失败保旧、Activity 暂停恢复、预览会话生命周期 |

针对性命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client exec vitest run \
  src/features/dashboard \
  src/pages/dashboard \
  src/features/device-mirror \
  src/features/automation/model \
  src/features/statistics/model \
  src/features/resource-invalidation \
  src/features/runtime-status
```

完整验证与视觉回归入口见[开发指南](development.md)。

## 10. 剩余边界

- 温度去重依赖 `dataUpdatedAt` 与缓存对象身份；同一毫秒内两次成功的完全相同采样在 Query 结构共享下可能被视为重复。5s 轮询下属于理论边界，未额外引入序列号。
- `DashboardSkeleton` 仍保留自己的网格测量与加载态 DOM，未纳入区域组件；首屏视觉依赖现有骨架结构。
- 总览没有展开/折叠状态；若后续新增，应按使用点留在对应区域，不进入快照 store。
- 流程区域只验证组合与局部展示；真实执行、停止与占用路径仍由执行控制器和既有页面/控制器测试覆盖。

## 关联

- [总览完整快照与设备采样](dashboard-snapshot.md)：五路读取、原子提交、采样与失效协调。
- [前端执行客户端与控制器](execution-client.md)：Dashboard 启动入口与 `scope`。
- [Query 缓存与键规范](query-cache.md)：默认策略与领域 key。
