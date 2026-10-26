# 作业领域面板

> [← 返回文档索引](README.md)

本文描述 FPR-036 交付的作业页面组合、面板职责与局部状态边界。配置草稿仍由 `user-config` 协调器持有，搜索/预览仍由 `combat` 域 Query 与 `CopilotPreviewSession` 持有，执行仍归 `task-execution` 控制器；本任务只调整页面/面板的职责、视图派生与会话存储，不新增第二份配置、预览、选择或运行状态。

相关契约：[作业搜索与预览](combat-search-preview.md)、[配置持久化协调器](config-persistence.md)、[前端执行客户端与控制器](execution-client.md)、[Query 缓存与键规范](query-cache.md)、[前端职责与质量基线](frontend-baseline.md)。

## 1. 定位与边界

| 内容 | 唯一归属 | 说明 |
| --- | --- | --- |
| 页面壳、页头与全局状态指示 | `pages/combat/CombatTasks.tsx` | 只渲染 `app-page`/`app-stack-section`、`PageHeader` 与工作区；不调用搜索/预览/执行 hook，不持有请求生命周期 |
| 模式、配置订阅、预览/搜索入口、执行订阅、作业集选择、同步反馈与重置弹层 | `features/combat/components/CombatWorkspace.tsx` | 跨面板唯一容器；`activeCombatMode`、`selectedCopilotIndexes` 与面板会话存储在这里创建 |
| 任务目录与模式展示项 | `features/combat/components/CombatTaskCatalog.tsx` | 名称、命令、图标、占位与描述；不读取配置/Query/执行状态 |
| 模式分段控件的测量与键盘导航 | `features/combat/components/CombatModeTabs.tsx` | 受控组件；只持有 `useFluidTabIndicator` 的测量状态 |
| 执行设置、编队/突袭/作业集模式与高级字段 | `components/CombatSettingsPanel.tsx`、`components/CombatAdvancedFields.tsx` | 受控表单；选项表来自 `model/combatCommands.ts` |
| 作业输入与识别方式 | `components/CombatCopilotInputPanel.tsx` | 输入值来自配置草稿；识别方式保存在面板会话存储 |
| 普通搜索与悖论搜索 | `components/CombatSearchPanel.tsx`、`components/CombatParadoxSearchPanel.tsx` | 搜索词与“已选中”高亮在面板侧；结果、取消与推荐接线由工作区提供 |
| 作业集预览、续跑进度、下一关与逐项结果 | `components/CombatCopilotSetPanel.tsx` | 只渲染 `CopilotSetView`；勾选/全选/重置/继续由工作区动作 |
| 作业信息详情 | `components/CombatCopilotInfoPanel.tsx` | 只渲染当前预览与视图派生 |
| 保全派驻 / 悖论模拟卡片 | `components/CombatSpecialTaskPanel.tsx` | 输入、URI 计数、高级字段、搜索与概览；不创建执行状态 |
| 卡片头部与运行/停止按钮 | `components/CombatTaskHeading.tsx` | 共享两种卡片的标题与执行投影 |
| 作业集视图派生 | `model/copilotSetView.ts` | 纯模型：当前 Run 归属、待执行求差、下一关与信息面板当前项 |
| 面板会话状态 | `model/panelState.ts` + `hooks/usePanelState.ts` | 工作区创建、面板订阅；页面卸载时销毁 |
| 命令、URI 与载荷模型 | `model/combatCommands.ts`、`utils/copilotUri.ts`、`model/copilotPayload.ts` | FPR-014/029 已交付；本任务只复核未改协议 |

非目标与保持不变：

- 不改变 `/agent/copilot/*`、`/agent/copilot-sets/*` 等端点、Query key、配置 key、本地存储键或 wire 形状。
- 不改变三种作业集执行方式的服务端映射：`app`/`cli` → `continuous`，`manual` → `manual`。
- 不把搜索词、识别方式、选中索引写进配置或 localStorage；不新增跨页共享。
- 不改变渲染结构、DOM/CSS 类名、表单 `id`/`name` 或默认态视觉；本任务没有新增样式或更新截图。
- 页面壳不包含业务状态机；工作区是唯一领域容器，面板只接收投影。

## 2. 组合与状态边界

```
CombatTasks（页面壳：PageHeader + FloatingStatusIndicator）
└─ CombatWorkspace（模式、配置、预览/搜索、执行、选择、同步反馈、重置弹层）
   ├─ CombatModeTabs（受控分段 + 高亮测量）
   ├─ CombatCopilotTaskPanel（普通作业卡）
   │  ├─ CombatSettingsPanel → CombatAdvancedFields
   │  ├─ CombatCopilotInputPanel（输入 + 识别方式）
   │  ├─ CombatCopilotSetPanel（续跑进度 / 下一关 / 逐项结果）
   │  ├─ CombatSearchPanel（关卡搜索 + 结果选择）
   │  └─ CombatCopilotInfoPanel（作业信息）
   ├─ CombatSpecialTaskPanel（保全派驻 / 悖论模拟卡）
   │  ├─ CombatAdvancedFields
   │  ├─ CombatParadoxSearchPanel（悖论干员搜索）
   │  └─ 执行/参数概览
   └─ aside（ScreenMonitor 预览）
```

| 状态 | 所有者 | 切换作业类型 | Activity 隐藏/恢复 | 真正卸载/刷新 |
| --- | --- | --- | --- | --- |
| 当前作业类型 | `CombatWorkspace` | 改变展示卡片 | 保留 | 回到 `copilot` |
| 配置草稿、pending 与提交队列 | `user-config` 协调器 | 不重建 | 保留；不重新读取已 hydrate 的草稿 | 应用级通道继续持有 |
| 预览对象、loading、请求代次 | `CopilotPreviewSession`（工作区实例） | 保留；卡片重建不取消当前预览 | `stop()` 取消在途读取、保留已显示预览；恢复不自动重放 | 新会话；预览清空 |
| 搜索词、搜索选中项、识别方式、悖论搜索词 | 工作区创建的面板会话存储 | 保留（存储不随卡片卸载） | 保留 | 重置 |
| 搜索结果、loading、取消代次 | `useCopilotSearch`/`useParadoxSearch`（工作区实例） | 保留 | 清理取消在途搜索；恢复不自动重放 | 重置 |
| 作业集待执行索引 | `CombatWorkspace` 本地状态 + `copilotSetSelections` 配置 | 保留 | 保留 | 重置；预览成功后按计划进度恢复 |
| 本次作业集 Run 投影、停止/继续确认 | `useCombatExecution` + `task-execution` 控制器 | 保留 | 计时器停止/重建；运行身份不变 | 控制器按持久化身份恢复 |
| 重置进度弹层与在途标记 | `CombatWorkspace` | 保留 | 保留 | 重置 |
| 续跑/失败/下一关视图 | `deriveCopilotSetView` 每次渲染派生 | — | — | — |

- **配置只有一个订阅。** 工作区调用一次 `useUserConfig(combatConfigAdapter)`，把草稿字段与更新回调传给卡片；面板不直接调用 `saveUserConfig`/`loadUserConfig` 或写 localStorage。
- **预览/搜索/执行各只有一个实例。** 工作区调用一次 `useCopilotPreview`、两个搜索 hook 与一次 `useCombatExecution`；卡片拿到的都是投影与动作，不创建第二份状态机。
- **选择是跨面板状态。** `selectedCopilotIndexes` 同时影响作业集列表、信息面板计数与提交请求，因此留在工作区；搜索词、搜索选中项和识别方式只影响单个面板，下沉到面板会话存储。
- **模式不持久化。** `activeCombatMode` 不进入配置、Query、localStorage 或 URL。

## 3. 局部状态与渲染隔离

`model/panelState.ts` 提供最小的会话存储：`get`/`set`/`subscribe`，相同值不通知。工作区用 `useState` 创建四个 store：

| store | 订阅方 | 工作区写入点 |
| --- | --- | --- |
| `copilotPreviewMode` | `CombatCopilotInputPanel` | 无；工作区在预览时读取当前值 |
| `copilotSearchStage` | `CombatSearchPanel` | 无 |
| `copilotSearchSelection` | `CombatSearchPanel` | 输入变化或应用搜索 URI 时清空/设置为规范化 URI |
| `paradoxSearchName` | `CombatParadoxSearchPanel` | 无 |

工作区本身**不订阅**这些 store，因此：

- 在搜索框输入、输入悖论干员名或切换识别方式时，只重渲染对应面板；作业集列表、配置表单与另一张作业卡不重渲染。
- 输入变化仍调用搜索 hook 的 `cancel()` 取消在途 Query；旧响应只写旧 key。
- 点击搜索结果会更新配置输入、写入搜索选中项并触发预览，这些动作本身需要工作区与作业集列表更新，属于相关更新。
- 切换作业类型会卸载卡片 DOM，但 store 由工作区持有，重新进入时搜索词、识别方式与搜索选中项保持不变。

回归：`CombatTasks.test.tsx` 的 “keeps the set list out of local search and recognition-mode renders” 用列表组件渲染计数验证输入不推动列表；同文件的模式切换用例验证局部状态跨卡片卸载保留。`panelState.test.ts` 覆盖通知、相同值与退订。

## 4. 作业集视图派生

`model/copilotSetView.ts` 把三份事实合成面板共用的只读视图：

| 规则 | 行为 |
| --- | --- |
| Run 归属 | 只有 `setRun.setId === preview.id` 且未被重置进度作废（`dismissedRunId`）的 Run 才提供逐项结果 |
| 待执行 | 页面选择减去本次 Run 已成功的索引；失败与未开始保留 |
| 失败/已执行 | 按 `itemStatuses` 折叠后的作业索引计数；`failed` 与 `stopped` 都计入失败 |
| 下一关 | 仅在 `isWaitingForNext` 且非 `isAutoStopping` 时展示；等待项与作业详情来自服务端投影 |
| 续跑目标 | 等待项索引优先，否则第一个待执行索引，否则 `-1` |
| 信息面板当前项 | 优先 Run 当前项，其次续跑目标，否则第一个作业；越界回退第一个作业 |
| 完成计数 | `max(0, 选择数 - 待执行数)` |

模型不访问 React、Query、配置通道或执行控制器，规则由 `copilotSetView.test.ts` 直接覆盖。

## 5. 搜索、执行与页面路径

- **搜索选择**：普通搜索结果点击后写入 `copilot.uri`、规范化并立即预览；`copilotSearchSelection` 驱动“已选中”高亮；修改主输入会清除非匹配的高亮。推荐 URI 仍只在本次显式搜索成功后自动应用。
- **三种作业集模式**：设置面板的 `app`/`manual`/`cli` 保持原选项与存储值；提交时 `app`/`cli` 映射为服务端 `continuous`，`manual` 保留逐关等待。取消/继续等待由 `useCombatExecution` 与服务端 Run 持有。
- **停止**：卡片按钮只调用工作区的 `stop()`；控制器按本客户端持有的 `runId` 停止，停止确认超时逻辑未改。
- **逐项结果**：作业集列表读取 `CopilotSetView.itemStatuses`，展示执行中/已完成/待重试/已完成跳过/待执行；页头计数来自同一视图。
- **重置进度**：确认后调用 reset 端点、把全部索引放回待执行、归零预览进度、失效该作业集计划缓存，并作废旧 Run 的逐项展示。

## 6. Activity 与卸载

- **Activity 隐藏/恢复**：搜索 hook 的清理取消在途 Query，预览会话 `stop()` 取消在途读取并保留已显示预览，执行 hook 清理停止确认计时器，模式分段清理 `ResizeObserver`/resize 监听；工作区与面板 state 保留。恢复时不自动重放搜索/预览/提交，Query 缓存按新鲜度复用，后台 Run 身份不变。
- **切换作业类型**：卡片 DOM 卸载，面板会话存储与工作区预览/搜索/执行实例保留；返回时输入与识别方式恢复。
- **真正卸载/刷新**：工作区与面板 store 销毁，搜索词/识别方式/搜索结果/选中索引/弹层重置；配置草稿、pending 队列和 Run 身份仍由应用级所有者持有，重新挂载后继续使用。

## 7. 兼容、视觉与回滚

- 端点、Query key、配置 key、本地存储键、pending 标记与 wire 形状均未变化；旧本地草稿与服务端配置可直接读取。
- 服务端执行参数、作业集模式映射、幂等键与停止语义未变化。
- 渲染结构与 DOM/CSS 类名保持：面板 JSX 由原页面原样迁出，表单 `id`/`name` 与默认态视觉不变；没有新增 CSS，也没有更新任何视觉基线。
- 实施时在仓库根执行 `pnpm visual -- --grep "app tab: combat"`；由于当前 pnpm 参数转发未生效，实际执行了全量 72 张比对，全部通过（未更新截图）。
- 回滚本任务的提交可恢复页面内联实现；配置、Query、执行与本地数据不需要迁移。

## 8. 回归证据

| 文件 | 覆盖 |
| --- | --- |
| `client/src/pages/combat/CombatTasks.test.tsx` | 既有配置迁移/pending/重试/迟到加载、三种模式、停止与超时、Activity、搜索/预览旧响应；新增搜索选择回填与预览、逐项结果与等待进度、局部输入不推动列表渲染、局部状态跨模式切换保留、保全派驻/悖论模拟命令接线 |
| `client/src/features/combat/model/copilotSetView.test.ts` | Run 归属、重置作废、待执行求差、失败/已执行计数、下一关与自动停止、续跑/当前项回退、单作业预览 |
| `client/src/features/combat/model/panelState.test.ts` | 初始值、通知、相同值抑制、退订、多订阅者、独立 store |
| `client/src/features/combat/model/combatCommands.test.ts`、`copilotSelection.test.ts`、`copilotPreviewSession.test.ts`、`queries.test.ts`、`api/index.test.ts`、`utils/copilotUri.test.ts` | 既有命令/选段/预览会话/Query/API/URI 回归 |

针对性命令（实施仓库根目录）：

```sh
pnpm --filter la-pluma-next-client exec vitest run src/features/combat
```

## 关联

- [作业搜索与预览](combat-search-preview.md)：搜索/预览资源身份、取消与旧响应裁决、选段与命令模型。
- [配置持久化协调器](config-persistence.md)：combat 配置适配器与 300ms 提交策略。
- [前端执行客户端与控制器](execution-client.md)：Run 身份、提交、停止与恢复。
- [前端职责与质量基线](frontend-baseline.md)：Combat 页职责与视觉复现入口。
