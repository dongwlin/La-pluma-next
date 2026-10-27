# 作业

> [← 返回前端架构](../README.md) · [文档索引](../../README.md)

本文集中维护本领域的面板、模型与命令约定；通用契约通过链接引用。

- [页面与面板](#页面与面板)
- [搜索与预览](#搜索与预览)
- [回归与关联](#回归与关联)

## 页面与面板

配置草稿仍由 `user-config` 协调器持有，搜索/预览仍由 `combat` 域 Query 与 `CopilotPreviewSession` 持有，执行仍归 `task-execution` 控制器；页面/面板分别持有组合、视图派生与会话存储，不新增第二份配置、预览、选择或运行状态。

### 1. 定位与边界

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
| 命令、URI 与载荷模型 | `model/combatCommands.ts`、`utils/copilotUri.ts`、`model/copilotPayload.ts` | 纯命令与载荷模型，不改变执行协议 |

维护约束：

- 不改变 `/agent/copilot/*`、`/agent/copilot-sets/*` 等端点、Query key、配置 key、本地存储键或 wire 形状。
- 不改变三种作业集执行方式的服务端映射：`app`/`cli` → `continuous`，`manual` → `manual`。
- 不把搜索词、识别方式、选中索引写进配置或 localStorage；不新增跨页共享。
- 不改变渲染结构、DOM/CSS 类名、表单 `id`/`name` 或默认态视觉；既有 DOM/CSS 与视觉约束保持不变。
- 页面壳不包含业务状态机；工作区是唯一领域容器，面板只接收投影。

### 2. 组合与状态边界

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

### 3. 局部状态与渲染隔离

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

### 4. 作业集视图派生

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

### 5. 搜索、执行与页面路径

- **搜索选择**：普通搜索结果点击后写入 `copilot.uri`、规范化并立即预览；`copilotSearchSelection` 驱动“已选中”高亮；修改主输入会清除非匹配的高亮。推荐 URI 仍只在本次显式搜索成功后自动应用。
- **三种作业集模式**：设置面板的 `app`/`manual`/`cli` 保持原选项与存储值；提交时 `app`/`cli` 映射为服务端 `continuous`，`manual` 保留逐关等待。取消/继续等待由 `useCombatExecution` 与服务端 Run 持有。
- **停止**：卡片按钮只调用工作区的 `stop()`；控制器按本客户端持有的 `runId` 停止，停止确认超时逻辑未改。
- **逐项结果**：作业集列表读取 `CopilotSetView.itemStatuses`，展示执行中/已完成/待重试/已完成跳过/待执行；页头计数来自同一视图。
- **重置进度**：确认后调用 reset 端点、把全部索引放回待执行、归零预览进度、失效该作业集计划缓存，并作废旧 Run 的逐项展示。

### 6. Activity 与卸载

- **Activity 隐藏/恢复**：搜索 hook 的清理取消在途 Query，预览会话 `stop()` 取消在途读取并保留已显示预览，执行 hook 清理停止确认计时器，模式分段清理 `ResizeObserver`/resize 监听；工作区与面板 state 保留。恢复时不自动重放搜索/预览/提交，Query 缓存按新鲜度复用，后台 Run 身份不变。
- **切换作业类型**：卡片 DOM 卸载，面板会话存储与工作区预览/搜索/执行实例保留；返回时输入与识别方式恢复。
- **真正卸载/刷新**：工作区与面板 store 销毁，搜索词/识别方式/搜索结果/选中索引/弹层重置；配置草稿、pending 队列和 Run 身份仍由应用级所有者持有，重新挂载后继续使用。

### 7. 兼容与视觉约束

- 端点、Query key、配置 key、本地存储键、pending 标记与 wire 形状均未变化；旧本地草稿与服务端配置可直接读取。
- 服务端执行参数、作业集模式映射、幂等键与停止语义未变化。
- 保持渲染结构、DOM/CSS 类名、表单 `id`/`name` 与默认态视觉；交互和局部状态边界由下列回归测试覆盖。
- 页面视觉回归入口见[开发指南](../../development/README.md)；面板行为与订阅隔离由下列回归测试覆盖。

## 搜索与预览

它把普通搜索、悖论搜索、单作业详情与作业集详情的读取从页面状态机移到 `combat` 域 Query 与预览会话；执行提交、运行观察与停止仍由 `task-execution` 控制器持有，配置草稿仍由 `user-config` 协调器持有。页面组合与面板边界见[作业领域面板](#页面与面板)。

### 1. 定位与边界

| 内容 | 唯一归属 | 说明 |
| --- | --- | --- |
| 搜索/详情/计划的只读端点、载荷解析与 query key | `features/combat/model/queries.ts`、`queryKeys.ts`、`copilotPayload.ts` | 只保存服务端只读资源；不写执行状态 |
| 搜索的提交与取消语义 | `features/combat/hooks/useCopilotSearch.ts` | 搜索词由搜索面板通过工作区会话存储持有；hook 提供代次与取消 |
| 预览请求裁决与当前展示 | `features/combat/model/copilotPreviewSession.ts` + `hooks/useCopilotPreview.ts` | 计划优先、成员回退、旧响应裁决、Activity 取消 |
| 预览目标与展示对象构造 | `features/combat/model/copilotPreview.ts` | 单作业/作业集/旧探测与提示文本 |
| 作业集选择 | `features/combat/model/copilotSelection.ts` | 序列化、待执行求差、按计划进度恢复 |
| 命令与执行选项 | `features/combat/model/combatCommands.ts` | 参数表、编队/突袭规则、输入校验、set 模式映射 |
| URI/输入归一 | `features/combat/utils/copilotUri.ts` | 纯 URI/输入模型，不访问网络 |
| 运行身份、提交/停止/继续 | `features/combat/hooks/useCombatExecution.ts` + `task-execution` | 搜索/预览生命周期不控制后台运行 |
| 配置草稿与 `copilotSetSelections` | `features/user-config` + `model/combatConfig.ts` | 选择写入仍走 300ms 去抖协调器 |

维护约束：

- 不以搜索/预览的资源生命周期启动、停止或恢复后台 Run。
- 不改变服务端端点、存储 key、配置 wire 或页面布局。
- 不把搜索/预览结果复制进 Zustand 或执行控制器。

### 2. 资源与缓存身份

资源 key、参数清单与缓存数值以[Query 缓存与键规范](../../architecture/query-cache.md)为准；本域读取顺序与显式刷新语义如下。

| 资源 | 端点与参数语义 | 域内读取策略 |
| --- | --- | --- |
| 普通搜索 | `GET /agent/copilot/search?stage=`，已提交的关卡搜索词 | 每次显式搜索重读；输入变化取消；失败时保留同一搜索词的上次结果 |
| 悖论搜索 | `GET /agent/paradox/search?name=`，已提交的干员搜索词 | 同上 |
| 单作业详情 | `GET /agent/copilots/:id`，PRTS 作业 id | 预览按钮复用新鲜缓存 |
| 作业集成员 | `GET /agent/copilot-sets/:id`，作业集 id | 仅在计划不可用/为空时读取，复用新鲜缓存 |
| 作业集计划 | `GET /agent/copilot-sets/:id/plan?raid=`，作业集 id 与 normal/raid/both 模式 | 计划优先；Run 终态刷新强制重读 |

关键规则：

- **key 只放影响响应的输入。** 识别方式（自动/单个/作业集）、预览按钮、选中索引与搜索框的未提交文字都不进入 key。
- **搜索词是缓存身份。** 切换关卡或干员得到新的 key；旧 key 的迟到响应只能写入旧缓存，当前页面只读新 key。
- **预览不建立第二份 key。** 组合读取通过 `fetchQuery` 使用上面的资源 key，不额外缓存“预览结果”。预览当前展示哪一次请求由会话裁决。
- **不轮询。** 搜索与预览都没有 `refetchInterval`；Activity 显示时按 Query 默认新鲜度重取，不自动重放用户操作。
- **写后只失效受影响的 key。** 重置进度成功后失效该作业集的 `copilot-set-plan` 前缀；作业集 Run 终态后的进度刷新把新计划写回同一 key。PRTS 作业内容没有跨页写入，不需要失效端口。

### 3. 搜索：取消与旧响应

`useCopilotSearch()` / `useParadoxSearch()` 提供相同的协议：

| 动作 | 行为 |
| --- | --- |
| 提交搜索 | 记录本次代次，`fetchQuery` 显式强制重新读取；返回 `success`/`failed`/`cancelled` |
| 输入变化 | 调用 `cancel()`：推进代次并 `cancelQueries(combatKeys.resource('copilot-search'))`；Query 的 `signal` 中止 fetch |
| Activity 隐藏/卸载 | Effect 清理调用 `cancel()`；显示时不自动重放搜索，成功结果仍在 Query 缓存 |
| 旧响应 | 代次不匹配的 Promise 返回 `cancelled`，页面不提示、不自动填充推荐 |

失败分类：

- `ApiRequestError.kind === 'api'` 或 `contract`：直接展示服务端/载荷消息（例如“未找到关卡…”），与迁移前一致。
- `transport` 或未知错误：展示 `搜索失败: <message>`。
- `AbortError`/取消：不展示为失败。

同一提交词再次搜索失败时，Query 保留上一次成功结果（页面仍显示旧列表）并提示错误；切换提交词时新 key 没有旧数据，列表自然清空。推荐的 `uri` 只在本次显式搜索成功后自动填充/预览一次，不通过 Effect 监听缓存，因此 Activity 恢复或后台重取不会覆盖用户当前输入。

### 4. 预览：会话与取消

`CopilotPreviewSession` 是预览的唯一请求入口：

| 能力 | 行为 |
| --- | --- |
| `load(input, mode, raid)` | 解析目标 → 取消上一次读取 → 设置 loading → 组合读取；只有仍当前的结论写入状态 |
| `refreshSet(setId, raid)` | 作业集 Run 终态后的静默强制重读（`force: true`）；只在当前预览仍是同一作业集时合并 `copilots`/`currentIndex` |
| `resetProgressView(setId)` | 重置进度成功后只把当前预览的 `currentIndex` 归零，不伪造服务端计划 |
| `clear()` | 输入变化/清除预览：取消在途读取并清空预览 |
| `cancel()` | 识别方式切换等场景：取消在途读取，保留已显示内容 |
| `start()` / `stop()` | 对应 Activity 显示/隐藏或真正卸载；停止时取消本地等待并结束 loading，恢复不自动重放 |

请求裁决：

- 每次读取递增 request id 并创建 `AbortController`；旧请求的 Promise 即使成功也返回 `cancelled`。
- 组合读取把实际使用的精确 Query key 登记到会话；取消时对每个 key 调用 `cancelQueries({ exact: true })`，Query 的 `signal` 中止 fetch。
- `stop()` 与 `clear()` 只取消本地读取，不调用停止端点，不影响后台 Run。

读取顺序与失败语义：

1. 作业集：计划优先。计划成功后直接构造成员列表。
2. 计划接口失败或返回空 `items`：回退成员列表 + 并发单作业详情；单个详情失败保留 `prts://<id>` 占位，仍可执行。
3. 计划与成员列表都失败：返回 `failed`；页面按失败类型展示消息（transport/unknown 前缀“网络错误:”）。
4. 读取成功但没有成员：返回 `empty`，页面提示“作业集不存在或为空”。
5. 单作业：详情 `status_code=200` 且可解析才展示；否则 `empty`（“作业不存在”）。
6. 旧探测：仅“自动”模式且原始输入不是 `prts://` 开头时（例如 prts.plus 链接）同时读取单作业与成员，作业集优先；保留 404/400 组合的“按作业集处理”兜底。

与迁移前的一处明确差异：**请求/服务端失败不再伪装成“作业不存在”**。旧页面把 `readApiResponse` 的失败信封也当作空内容；现在单作业/作业集在计划与成员都失败时显示网络或服务端消息。成功但为空的响应仍显示“不存在/为空”。搜索的失败分类见第 3 节；`cancelled` 始终静默。

### 5. 选择、配置与执行接线

- 工作区持有当前 `selectedCopilotIndexes`；`copilotSetSelections[setId]` 仍由 `user-config` 协调器持久化，本地键与 wire 形状不变。
- `serializeCopilotSelection` 去重、丢弃非整数并升序；`selectedCopilotItemIndexes` 把选择裁剪到当前列表；`pendingCopilotItemIndexes` 从页面选择中减去本次 Run 已成功的条目。
- 预览成功（作业集）后按服务端计划进度恢复选择：`restorableCopilotIndexes` 以计划中“仍待执行”的索引为全集；没有保存过选择时使用全部待执行项，保存过则求交。预设编队只要求普通模式，突袭/两者按作业支持的模式判断。
- 作业集 Run 终态后 `refreshSet` 强制重读计划并合并逐项结果，页面再用同一纯模型恢复选择；失败只影响展示，不把 Run 结果解释成完成。
- 重置进度成功后：全部索引进入待执行、预览 `currentIndex` 归零、失效该作业集的计划缓存。
- 提交：单作业/SSS/悖论走 `buildCombatCommandArgs`；作业集走 `buildCopilotSetExecutionOptions` + 选中的索引。`app`/`cli` 都映射为服务端 `continuous`，`manual` 保留逐关等待。空值、未勾选 checkbox 与无参数名的策略项不写入命令。
- **搜索缓存与执行状态分开。** 搜索/预览只读写 Query 与预览会话；执行只读写 `task-execution` 控制器。搜索失败、切换搜索词或 Activity 隐藏都不会停止、重启或重提 Run。

### 6. 兼容格式

| 载荷 | 兼容处理 |
| --- | --- |
| PRTS 代理 | 接受 `{ success, data }` 信封与直接的 `{ status_code, data }` 对象；`content` 可为 JSON 字符串或已解析对象 |
| 单作业内容 | `doc.title` 缺失回退“未命名作业”；`opers`/`groups` 拼成“名字、[组名]”；无展示项为“未知” |
| 作业集成员 | `data.copilot_ids` 接受数字或数字字符串；丢弃 0、负数、小数与重复项 |
| 作业集计划 | `items` 与 `entries` 必须同时存在；`completed` 条目按 `itemIndex` 折叠为 `completedModes`；`stage` 缺失时名称回退“作业 #id” |
| 搜索结果 | 接受信封/原始载荷；缺 `uri` 的条目丢弃；`recommended` 只有带 `uri` 才自动填充；`views`/`hotScore` 缺失按 0 |
| 旧探测 | `prts://<id>` 的“自动”模式按单作业处理，不会猜测同 id 作业集；prts.plus 链接继续探测 |
| 执行 | raid `1`/`2` 规范化为 `raid`/`both`；未带 s 前缀的作业集在预览与执行时补 `prts://s<id>` |

服务端端点保持兼容；配置 key、本地存储键、pending 与 wire 形状由[配置持久化协调器](../../architecture/config-persistence.md)统一定义。搜索与预览应继续经过领域 Query 和预览会话，不在页面重建请求状态机。

### 7. Activity 与卸载

- Query 观察者随 Effect 清理注销；在途读取通过 `signal` 取消，缓存保留并按 `gcTime` 回收。
- 预览会话 `stop()` 取消在途读取并结束 loading，保留已显示预览；恢复 `start()` 不自动重放。
- 搜索 hook 在清理时取消在途搜索；恢复后不自动重放，成功结果仍可从 Query 缓存读取。
- 真正卸载后重挂载会重置搜索词、识别方式与选中索引；Query 缓存若仍新鲜可直接复用。切换作业类型只卸载卡片 DOM，工作区持有的面板会话存储会保留这些局部输入。
- 后台 Run 与配置提交不依赖本页 Activity；隐藏不会改变运行所有权。

## 回归与关联

### 回归测试

| 文件 | 覆盖 |
| --- | --- |
| `client/src/pages/combat/CombatTasks.test.tsx` | 配置迁移/pending/重试/迟到加载；三种模式、停止与超时、Activity；搜索/预览旧响应与 AbortSignal、选择写入配置并提交选中索引、推荐回填与预览、失败保留旧预览、搜索失败消息与运行状态隔离；逐项结果与等待进度；局部输入不推动列表渲染、局部状态跨模式保留；保全派驻/悖论命令接线 |
| `client/src/features/combat/model/copilotSetView.test.ts` | Run 归属、重置作废、待执行求差、失败/已执行计数、下一关与自动停止、续跑/当前项回退、单作业预览 |
| `client/src/features/combat/model/panelState.test.ts` | 初始值、通知、相同值抑制、退订、多订阅者、独立 store |
| `client/src/features/combat/model/combatCommands.test.ts` | 高级参数表、编队/突袭规则、set 前缀改写、set options、app/cli 映射、输入校验 |
| `client/src/features/combat/model/copilotSelection.test.ts` | 去重排序、待执行求差、突袭/两者/预设编队、本地选择与计划求交、全选/清空 |
| `client/src/features/combat/model/copilotPreviewSession.test.ts` | loading/ready、旧响应取消、tracked key 取消、Activity 停止/恢复、静默刷新、进度视图 |
| `client/src/features/combat/model/queries.test.ts` | 资源 key、signal 传递与取消、失败分类、计划优先/成员回退、探测、强制刷新 |
| `client/src/features/combat/api/index.test.ts` | 领域 API 回归 |
| `client/src/features/combat/utils/copilotUri.test.ts` | prts://、prts.plus、本地文件、多行输入与不支持输入 |
| `client/src/features/combat/model/copilotPayload.test.ts` | 搜索/悖论载荷、PRTS 代理字符串/对象 content、缺失标题、成员 id 兼容、计划 completedModes 与非法载荷 |
| `client/src/features/combat/model/copilotPreview.test.ts` | 自动/单个/作业集目标解析、prts.plus 探测、s 前缀、预览对象与旧兜底 |

### 验证命令

以下命令均在仓库根目录执行。

```sh
pnpm --filter la-pluma-next-client exec vitest run src/features/combat src/pages/combat
```

完整验证与视觉回归入口见[开发指南](../../development/README.md)。

### 关联契约

- [配置持久化协调器](../../architecture/config-persistence.md)
- [前端执行客户端与控制器](../../architecture/execution-client.md)
- [Query 缓存与键规范](../../architecture/query-cache.md)
- [前端架构与所有权](../README.md)
- [资源请求错误与取消契约](../../architecture/resource-requests.md)
