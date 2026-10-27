# 统计数据领域面板

> [← 返回文档索引](README.md)

本文说明统计页面组合、面板局部状态与纯模型。四类读取仍由领域 Query 持有，识别/材料命令仍由 `features/statistics/model/commandOwner.ts` 持有；页面/面板分别承担界面组合与局部状态生命期，不新增第二份缓存、命令状态或存储。

相关契约：[统计识别命令与失效联动](statistics-commands.md)、[Query 缓存与键规范](query-cache.md)、[共享资源归属与失效端口](resource-ownership.md)、[前端架构与所有权](frontend-architecture.md)。

## 1. 定位与边界

| 内容 | 唯一归属 | 说明 |
| --- | --- | --- |
| 页面壳、页头与全局状态指示 | `pages/statistics/DataStatistics.tsx` | 只渲染 `app-page`/`app-stack-section`、`PageHeader` 与工作区 |
| 当前 tab、命令投影与失效订阅 | `features/statistics/components/StatisticsWorkspace.tsx` | 跨面板唯一容器；tab 不写入存储或 URL |
| tab 分段控件的测量与键盘导航 | `features/statistics/components/StatisticsTabs.tsx` | 受控组件；只持有 `useFluidTabIndicator` 的测量状态 |
| 干员读取、筛选/排序、筛选菜单、头像缓存 | `features/statistics/components/OperatorPanel.tsx` | 读取 `operbox` 与 `catalog` 两路 Query |
| 仓库读取、失败图标与分类展示 | `features/statistics/components/DepotPanel.tsx` | 汇总结果由纯模型派生 |
| 掉落周期与掉落读取 | `features/statistics/components/DropPanel.tsx` | `DropRecords` 退为纯视图 |
| 筛选菜单的测量、portal、焦点与键盘 | `features/statistics/components/FilterMenu.tsx` | 规则跟随组件，面板只传值与选项 |
| 筛选、排序与阿米娅形态规则 | `features/statistics/model/operatorFilters.ts` | 已实现 |
| 仓库分类标签、分组与概览 | `features/statistics/model/depotSummary.ts` | 纯模型 |
| 掉落材料/关卡排序与展示上限 | `features/statistics/model/dropRecords.ts` | 纯模型 |
| 识别/材料命令生命周期 | `model/commandOwner.ts` + `hooks/useStatisticsCommands.ts` | 所有者是模块级单例；hook 只订阅、投影并写回解析快照 |
| 四类资源读取 | `game-data` 与 `statistics` 的 query 定义 | key、失效作用域与重取策略均未变 |

维护约束：

- 不改变四路读取的首屏时机、失效作用域与 Query key。
- 不持久化 `activeTab`、筛选、排序或掉落统计周期；真正卸载/刷新后回到默认值。
- 不改变渲染结构、DOM/CSS 类名或默认态视觉。

## 2. 组合与状态边界

```
DataStatistics（页面壳：页头、全局状态指示）
└─ StatisticsWorkspace（当前 tab、命令投影、资源失效订阅）
   ├─ StatisticsTabs（受控分段控件 + 高亮测量）
   ├─ OperatorPanel（operbox/catalog 读取 + 筛选/排序/菜单/头像缓存）
   ├─ DepotPanel（depot 读取 + 汇总展示 + 图标失败缓存）
   └─ DropPanel（掉落读取 + 统计周期）→ DropRecords（视图）
```

- **三个面板随页面挂载而常驻**：非当前 tab 时面板在跑完 hooks 后返回 `null`，因此四路读取仍在页面首屏并行启动，与迁移前一致；tab 切换不会重建 Query 观察者，也不会丢失筛选、排序、打开菜单、掉落周期或图标缓存。面板的 `null` 渲染保证同一时刻只有当前 tab 的 DOM 存在，文本查询与像素结果不变。
- **当前 tab** 是跨面板的局部交互状态，由工作区持有；它不进入配置、Query、localStorage 或 URL。`Activity` 隐藏/恢复保留；真正卸载或刷新后回到默认的 `operbox`。
- **识别/材料命令**只有一份页面投影：`useStatisticsCommands()` 在工作区调用一次 `useStatisticsCommandState()`，把 `isRunning`、`activeTask`、`activeKind`、按钮文案与两个动作投影给干员/仓库面板。面板不创建第二份状态机；按钮的 loading/disabled 都从该投影派生，跨面板互斥仍由命令所有者的单飞保证。
- **解析快照**由该 hook 写回 `gameDataKeys.resource('depot')` / `('operbox')`；跨域失效仍由命令所有者发布，工作区只订阅 `depot`/`operbox`/`catalog`/`drops` 四个作用域并按 key 失效。
- **掉落视图** `DropRecords` 只接收 `dropStatistics`、`dropDays`、`setDropDays`、`onRefresh`、loading 与错误文案；周期状态与 Query 归 `DropPanel`。
- 面板可调用所属领域 hooks；筛选菜单的定位、焦点与键盘规则不外溢到面板。

## 3. 筛选菜单规则

`FilterMenu` 从页面迁出后仍保持原规则：

- 打开状态与当前值由面板持有，组件只接收 `isOpen`/`value`/`options`，测量状态（`menuPosition`）留在组件内。
- 菜单通过 `createPortal` 挂到 `document.body`；按视口剩余空间选择上下方向，左右夹在最小 16px 边距内；手机端行尾菜单可用 `mobileAlign="end"` 对齐触发器右缘。
- 打开时聚焦已选项（不存在则第一项）；`ArrowUp`/`ArrowDown` 循环、`Home`/`End` 跳转；`Escape` 关闭并把焦点还给触发器；选择后关闭并归还焦点；外部 `pointerdown`/`focusin` 关闭。
- 触发器保留 `aria-haspopup`、`aria-expanded`、`aria-controls`，菜单保留 `role="menu"` 与 `role="menuitemradio"` 的 `aria-checked`。

## 4. 纯模型

| 模块 | 导出 | 规则 |
| --- | --- | --- |
| `model/operatorFilters.ts` | `selectOperators`、`buildOwnedOperatorIdSet`、`hasActiveOperatorFilters` 等 | 阿米娅形态共享持有状态；未拥有视图忽略精英/潜能筛选；非已拥有视图按星级与中文名排序 |
| `model/depotSummary.ts` | `summarizeDepot`、`summarizeDepotTypes`、`getDepotTypeLabel` | 分类按库存件数降序，件数相同保留首次出现顺序；`itemCount` 用服务端快照值；空快照返回全零 |
| `model/dropRecords.ts` | `sortDropItems`、`sortDropStages`、`DROP_ITEM_DISPLAY_LIMIT` | 材料按数量、关卡按战斗次数降序；并列保留服务端键顺序；最多展示 20 种材料 |

这些模块不访问 React、Query、命令所有者或网络，可用纯 Node 测试覆盖。

## 5. Activity 与卸载

- `Activity` 隐藏会清理页面与面板的 Effects（筛选菜单的 document/window 监听、Query 观察者、`useFluidTabIndicator` 的 ResizeObserver/resize 监听），但保留 React state：当前 tab、筛选、打开状态、掉落周期与图标缓存不变。恢复时 Query 按 `staleTime` 决定是否重取；筛选菜单若仍处于打开状态会重新附加监听并聚焦选中项。
- 命令所有者不随页面生命周期重建或中止：隐藏期间识别/材料命令继续完成，解析快照写入应用级 QueryClient；恢复后按失效 revision 补一次读取。页面不会因隐藏或重挂载重复提交设备命令。
- 真正卸载/刷新会销毁 tab 与面板局部状态；Query 缓存（`game-data` 的 depot/operbox/catalog 与 `statistics` 的 drops）由应用级 QueryClient 持有，可在新鲜期内复用。
- 页面不使用业务 localStorage；执行控制器持久化的是 Run 身份，不属于本页。

## 6. 兼容与维护约束

- 四路 Query key、失效作用域、`staleTime`/`gcTime`/重试策略未变；首屏仍同时启动四路读取。
- 识别/材料命令的端点、幂等键、超时与失效发布未变；材料刷新仍不重读干员目录。
- 保持渲染结构、DOM/CSS 类名、表单 `id` 与默认态视觉；筛选菜单、tab 导航和局部状态由下列回归测试覆盖。

## 7. 回归测试

| 文件 | 覆盖 |
| --- | --- |
| `features/statistics/components/FilterMenu.test.tsx` | portal 挂载、上下方向与边距、手机端右对齐、打开聚焦、方向键/Home/End、Escape 与选择后的焦点归还、外部关闭、aria 关联 |
| `features/statistics/components/DropPanel.test.tsx` | 非当前 tab 仍启动首屏读取、周期切换进入 Query key、隐藏/恢复保留周期且不重复读取、失败重试 |
| `features/statistics/components/DropRecords.test.tsx` | 平滑圆角、空态、加载、错误重试、刷新失败保留旧结果 |
| `features/statistics/model/depotSummary.test.ts` | 分类标签、分组顺序与并列顺序、服务端物品数、材料种类、总量、最大库存、空快照 |
| `features/statistics/model/dropRecords.test.ts` | 材料/关卡降序、并列顺序、图标身份、空记录、展示上限 |
| `features/statistics/model/operatorFilters.test.ts` | 既有筛选/排序与阿米娅规则 |
| `pages/statistics/DataStatistics.layout.test.tsx` | tab 键盘切换、四路首屏并行、独立错误与重试、筛选跨 tab 保留、识别快照/失效、命令单飞与超时继续、Activity 隐藏/恢复、图标失败回退 |
| `features/statistics/model/commandOwner.test.ts` | 命令所有者既有超时/取消/继续/发布回归 |
| `features/statistics/model/queries.test.ts`、`api/index.test.ts` | 掉落/今日资源的 key、signal 与信封归一 |

针对性命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client exec vitest run src/features/statistics src/pages/statistics
```
