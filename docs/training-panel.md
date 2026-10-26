# 养成领域面板

> [← 返回文档索引](README.md)

本文描述 FPR-033 交付的养成页面组合、面板局部状态与纯模型。队列、设置与计划的领域所有者、Query key、失效作用域和视觉均未改变；本任务只调整页面/面板/选择器的职责与状态生命期，不新增缓存、命令状态或存储。

相关契约：[养成队列命令与写后刷新](training-queue-commands.md)、[养成设置提交与计划有效期](training-settings-and-plan-validity.md)、[Query 缓存与键规范](query-cache.md)、[共享资源归属与失效端口](resource-ownership.md)、[前端职责与质量基线](frontend-baseline.md)。

## 1. 定位与边界

| 内容 | 唯一归属 | 说明 |
| --- | --- | --- |
| 页面壳 | `features/training/pages/OperatorTraining.tsx` | 只渲染 `app-page`/`data-page` 并组合工作区 |
| 页头、工作区布局与共享版本边界 | `features/training/components/TrainingWorkspace.tsx` | 队列读取、计划/设置/队列命令适配、失效订阅、选择器开关与操作错误 |
| 队列列表、行内操作与撤销提示 | `features/training/components/TrainingQueuePanel.tsx` | 操作成功后把焦点还给队列标题；`UndoToast` 跟随该面板渲染 |
| 当前目标材料 | `features/training/components/TrainingMaterialsPanel.tsx` | 只从队列首位派生，不读取资源 |
| 刷图计划展示与范围选择 | `features/training/components/TrainingPlanPanel.tsx` | 持有 `current`/`all` 这一局部状态；生成/应用/同步仍调用工作区回调 |
| 自动化设置开关 | `features/training/components/TrainingSettingsPanel.tsx` | 只把开关变化组成完整设置交给设置所有者 |
| 添加干员选择器 | `features/training/components/OperatorPicker.tsx` | 候选/计数 Query、状态筛选、稀有度、未精二、搜索、分批渲染与头像缓存 |
| 材料表格与合成树 | `features/training/components/MaterialViews.tsx` | 纯展示；图标失败时隐藏图片保留占位 |
| 撤销提示 | `features/training/components/UndoToast.tsx` | portal、8 秒自动关闭、悬停/焦点/pending 暂停 |
| 干员行规则 | `features/training/model/operatorRows.ts` | 搜索匹配、分批、空态文案与卡片动作 |
| 材料规则 | `features/training/model/materials.ts` | 龙门币追加、缺口筛选与当前目标摘要 |
| 计划展示规则 | `features/training/model/planDisplay.ts` | 当日开放关卡投影、次数/理智与焦点干员 |
| 队列写入、设置提交、计划编排 | `model/queueCommands.ts`、`model/settingsCommands.ts`、`model/planCommands.ts` | FPR-021/022/023 已有所有者，本任务未改协议 |

非目标：

- 不改变队列、候选、计数三类 Query 的 key、读取时机、失效作用域与失败语义。
- 不持久化筛选、搜索、分批游标、计划范围或选择器开关；真正卸载/刷新后回到默认值。
- 不改变渲染结构、DOM 类名、CSS 或默认态视觉；不更新视觉基线。
- 不新增页面级 `useTrainingPage` 之类的整页 hook；读取仍由各面板各自的 hook/Query 持有。

## 2. 组合与状态边界

```
OperatorTraining（页面壳）
└─ TrainingWorkspace（队列读取、共享版本边界、失效订阅、选择器/错误/撤销快照）
   ├─ TrainingQueuePanel（队列列表 + 行内操作 + UndoToast）
   ├─ TrainingMaterialsPanel（当前目标材料）→ MaterialViews
   ├─ TrainingPlanPanel（计划范围 + 计划展示 + 生成/应用/同步入口）
   ├─ TrainingSettingsPanel（自动切换/完成通知）
   └─ OperatorPicker（候选/计数读取 + 筛选/搜索/分批 + Modal）
```

- **页面无请求。** `OperatorTraining` 不导入 API、Query、领域命令或 localStorage；它只组合工作区。页头里的“添加干员”按钮依赖选择器开关，因此页头随工作区渲染，避免把跨面板交互状态上移到页面。
- **共享版本边界在工作区。** 工作区是唯一同时持有队列快照、设置 revision 与计划 basis 的位置：队列供队列面板/材料面板/计划面板/选择器共用，`queueRevision` 与 `settingsRevision` 的合流只在这里发生一次。
- **队列写入仍归领域命令。** 工作区把 QueryClient 注入 `useTrainingQueueCommands()`，并把 `add`/`remove`/`undo`/`reorder` 的意图交给模块级命令所有者；写后刷新、重复合并、`uncertain` fallback 与失效发布都不在组件里。
- **面板可调用所属领域 hook；展示组件只接 props。** 选择器持有候选/计数 Query 与自身交互状态；计划、设置、队列面板只接收工作区投影与回调。计划范围切换、队列行操作、撤销提示关闭等局部交互都在最近的使用点。
- **错误显示位置保持原样。** 队列区显示 `operationError`，选择器内也显示同一份错误；错误状态由工作区持有，避免两个面板各存一份互相覆盖。

## 3. 共享版本边界与失效

| 事件 | 工作区动作 | 计划结果 |
| --- | --- | --- |
| 队列命令开始（增删/排序/撤销） | 立即 `invalidatePlan()`，再入队命令 | 旧预览立刻不可应用 |
| 设置开关编辑 | 立即 `invalidatePlan()`，再调用设置所有者 `update` | 写入失败也不复活旧计划 |
| 队列权威读取 revision 变化 | `useTrainingPlan` 观察快照并作废旧计划 | 外部客户端/识别造成的队列变化被发现 |
| 设置写入/权威重读采用新值 | 设置所有者推进 revision，工作区按 revision 判定 basis | 旧计划失效 |
| 外部 `training-plan` 失效 | 工作区订阅并 `invalidatePlan()` | 识别/材料刷新后需重新预览 |
| 队列写入自己的失效发布 | 忽略（权威快照已写入同一 key） | 不重复重读 |
| 设置所有者自己的 `training-plan` 发布 | 忽略（编辑时已按 revision 作废） | 写入期间生成的预览不被清空 |

失效订阅仍只在工作区建一次：

- `depot`/`operbox`/`catalog`/`materials` → 失效候选与计数 Query（按 key）；
- `depot`/`materials`/`training-queue` → 重读队列；
- `depot`/`materials`/`training-plan` → 作废旧计划。

`OperatorPicker` 不订阅失效端口，只作为候选/计数 Query 的观察者跟随缓存变化。

## 4. 面板局部状态与生命期

| 状态 | 所有者 | Activity 隐藏/恢复 | 真正卸载/刷新 |
| --- | --- | --- | --- |
| 选择器开关 | 工作区 | 保留；恢复后仍打开 | 回到关闭 |
| `operationError` | 工作区 | 保留 | 清空 |
| 移除后的撤销快照 | 工作区 | 保留；提示重新计时 8 秒 | 清空 |
| 状态筛选/稀有度/未精二 | `OperatorPicker` | 保留 | 回到默认（可养成、全部稀有度、未精二） |
| 搜索词、分批游标 | `OperatorPicker` | 保留 | 回到默认（空搜索、72 行） |
| 头像加载缓存 | `OperatorPicker` | 保留 | 清空 |
| 计划范围（`current`/`all`） | `TrainingPlanPanel` | 保留 | 回到 `current` |
| 队列、设置、计划、pending | 领域所有者/Query | 不随页面重建；Query 观察者随 Effect 注销/恢复 | 队列与设置所有者、缓存继续存在；计划状态保留到所有者在动作中重置 |

- 选择器关闭只卸载 Modal 内容；选择器组件本身常驻，因此搜索、筛选与分批游标在再次打开时保留，与迁移前页面状态的行为一致。
- 候选/计数 Query 在选择器挂载时就启动，因此仍随页面首屏并行读取；选择器关闭不会取消已完成的读取，也不会在打开时重新建立 key。
- 状态筛选切换仍会把“未精二”重置为 `false`（`status === 'all'` 时），与迁移前一致。
- 计划范围被清空只发生在真正卸载；切换范围仍会立即作废旧预览。

## 5. 纯模型

| 模块 | 导出 | 规则 |
| --- | --- | --- |
| `model/operatorRows.ts` | `filterOperatorRows`、`paginateOperatorRows`、`nextOperatorRenderLimit`、`resolveOperatorEmptyState`、`describeOperatorRow` | 搜索去空白并忽略大小写；空搜索返回新数组；每次渲染 72 行；空态优先搜索/稀有度，再按状态；已入队优先于未拥有/缺数据文案 |
| `model/materials.ts` | `getQueueMaterials`、`selectMissingMaterials`、`summarizeTargetMaterials` | 龙门币追加在普通材料之后并作为缺口计数；空队列返回固定标题与说明；进度保持服务端原值 |
| `model/planDisplay.ts` | `getOpenStagePlan`、`selectTodayStages`、`getOpenStageCount`、`summarizeTodayPlan`、`getPlanFocusName` | `openStages` 优先（包括空数组），否则按 `isOpen !== false` 过滤；理智回查完整 `stages` 的 `sanityPerRun`；焦点顺序为计划焦点 → 计划首位 → 队列当前 → 未设置 |

`getOpenStagePlan` 由 `planCommands.ts` 迁到展示模型，供页面渲染与应用提交共用；`planCommands` 仍负责应用编排并从这里导入，行为不变。这些模块不访问 React、Query、命令所有者或网络，可用纯 Node 测试覆盖。

## 6. 选择器焦点、键盘与弹层

- `Modal` 继续负责 portal、背景 `inert`/滚动锁定、Tab 循环、Escape 关闭与触发器焦点归还；“添加干员”和“继续添加”仍是同一个开关入口。
- 状态分段保留 `role="toolbar"`、`aria-pressed`、`tabIndex` 与方向键/Home/End 导航；高亮测量仍由 `useFluidTabIndicator` 持有。
- 搜索框 `aria-label="搜索干员名称"`、稀有度 `select[aria-label="稀有度"]`、添加按钮的 `aria-label`/禁用/加载文案均保持。
- 分批按钮仍显示 `继续显示 N 个` 与 `已显示 X / Y`；搜索或筛选变化会把游标复位到 72。
- 空态、列表失败与队列失败仍使用可重试的 `TrainingLoadError`，不把失败呈现为空列表。

## 7. Activity 与卸载

- `Activity` 隐藏只清理 Effects：队列/候选/计数 Query 观察者注销，撤销提示计时器清理；React state（筛选、搜索、分批游标、头像缓存、计划范围、选择器开关、操作错误、撤销快照）保留。恢复后 Query 按新鲜度重取，撤销提示重新计时 8 秒。
- 队列命令、设置写入与计划生成/应用/同步都是模块级所有者：隐藏或真正卸载不会重建串行链、取消写请求或清空 pending；恢复时工作区重新订阅所有者状态。
- 真正卸载会销毁面板局部状态并由新页面从默认值开始；应用级 QueryClient 中的队列/候选/计数缓存和所有者状态继续可用。

## 8. 兼容与回滚

- Query key、读取时机、失效作用域、失败保旧与 `uncertain` 语义未变；选择器关闭不改变候选/计数读取的启动时机。
- 队列/设置/计划的所有者 API、端点与失效发布未变；`training-plan-applied` window 事件仍未恢复。
- 渲染结构、DOM 类名、表单 `id` 前缀、`aria-*` 与默认态视觉保持：面板 JSX 由原页面原样迁出。迁移时用离线渲染对比默认页面与选择器弹层的 DOM，除 React `useId` 生成值随组件层级变化外无节点或属性差异；没有新增样式或更新截图。
- 唯一的结构性文件移动是 `getOpenStagePlan` 从 `planCommands.ts` 迁到 `planDisplay.ts`；它不是 feature 公开面成员，仓库内只有页面与计划所有者使用。
- 回滚本次面板提交即可恢复页面内联实现；Query 缓存、所有者与本地数据不需要迁移。

## 9. 回归证据

| 文件 | 覆盖 |
| --- | --- |
| `features/training/model/operatorRows.test.ts` | 搜索去空白/大小写、空搜索复制、72 行分批与剩余计数、0/负游标、空态优先级、卡片动作与蒙版状态 |
| `features/training/model/materials.test.ts` | 龙门币末项与缺口计数、无 LMD 复用原数组、缺口筛选、空目标、已集齐、缺省进度 |
| `features/training/model/planDisplay.test.ts` | `openStages` 优先与空数组、`stages` 回退、开放关卡计数、次数/理智回查、缺省元数据、焦点回退 |
| `features/training/components/OperatorPicker.test.tsx` | 搜索与无结果空态、分批渲染与“继续显示”、关闭再打开保留搜索与游标 |
| `features/training/components/MaterialViews.test.tsx` | 表格 role/列头/缺口与已齐、嵌套合成层级 |
| `features/training/components/UndoToast.test.tsx` | portal 在页面容器外、`role="status"`/`aria-live`、8 秒关闭、悬停/焦点/pending 暂停、失焦恢复 |
| `features/training/pages/OperatorTraining.test.tsx` | 既有 56 项回归：队列增删排序撤销、写后刷新 fallback、设置串行、计划版本/生成/应用/部分成功、选择器焦点、Activity 隐藏恢复、材料展示与错误重试 |
| `features/training/model/queueCommands.test.ts`、`settingsCommands.test.ts`、`planCommands.test.ts`、`planValidity.test.ts` | 领域所有者既有回归（本任务未改） |

针对性命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client exec vitest run src/features/training
```

完整 `pnpm --filter la-pluma-next-client verify` 与 72 张视觉比对由任务完成记录给出；本文件不声称未执行的验证。

## 关联

- [养成队列命令与写后刷新](training-queue-commands.md)：队列唯一可写真相、串行命令、revision 与不确定 fallback。
- [养成设置提交与计划有效期](training-settings-and-plan-validity.md)：设置 revision、计划 basis、生成/应用/同步与配置写入屏障。
- [共享资源归属与失效端口](resource-ownership.md)：候选/计数/队列的归属与触发映射。
- [前端职责与质量基线](frontend-baseline.md)：Activity 生命周期、页面职责与视觉基线。
