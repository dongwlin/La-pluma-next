# 作业搜索与预览

> [← 返回文档索引](README.md)

本文说明作业搜索、预览、选段与命令模型。它把普通搜索、悖论搜索、单作业详情与作业集详情的读取从页面状态机移到 `combat` 域 Query 与预览会话；执行提交、运行观察与停止仍由 `task-execution` 控制器持有，配置草稿仍由 `user-config` 协调器持有。页面组合与面板边界见[作业领域面板](combat-panel.md)。

相关契约：[Query 缓存与键规范](query-cache.md)、[资源请求错误与取消契约](resource-requests.md)、[配置持久化协调器](config-persistence.md)、[前端执行客户端与控制器](execution-client.md)。

## 1. 定位与边界

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

## 2. 资源与缓存身份

资源 key、参数清单与缓存数值以[Query 缓存与键规范](query-cache.md)为准；本域读取顺序与显式刷新语义如下。

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

## 3. 搜索：取消与旧响应

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

## 4. 预览：会话与取消

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

## 5. 选择、配置与执行接线

- 工作区持有当前 `selectedCopilotIndexes`；`copilotSetSelections[setId]` 仍由 `user-config` 协调器持久化，本地键与 wire 形状不变。
- `serializeCopilotSelection` 去重、丢弃非整数并升序；`selectedCopilotItemIndexes` 把选择裁剪到当前列表；`pendingCopilotItemIndexes` 从页面选择中减去本次 Run 已成功的条目。
- 预览成功（作业集）后按服务端计划进度恢复选择：`restorableCopilotIndexes` 以计划中“仍待执行”的索引为全集；没有保存过选择时使用全部待执行项，保存过则求交。预设编队只要求普通模式，突袭/两者按作业支持的模式判断。
- 作业集 Run 终态后 `refreshSet` 强制重读计划并合并逐项结果，页面再用同一纯模型恢复选择；失败只影响展示，不把 Run 结果解释成完成。
- 重置进度成功后：全部索引进入待执行、预览 `currentIndex` 归零、失效该作业集的计划缓存。
- 提交：单作业/SSS/悖论走 `buildCombatCommandArgs`；作业集走 `buildCopilotSetExecutionOptions` + 选中的索引。`app`/`cli` 都映射为服务端 `continuous`，`manual` 保留逐关等待。空值、未勾选 checkbox 与无参数名的策略项不写入命令。
- **搜索缓存与执行状态分开。** 搜索/预览只读写 Query 与预览会话；执行只读写 `task-execution` 控制器。搜索失败、切换搜索词或 Activity 隐藏都不会停止、重启或重提 Run。

## 6. 兼容格式

| 载荷 | 兼容处理 |
| --- | --- |
| PRTS 代理 | 接受 `{ success, data }` 信封与直接的 `{ status_code, data }` 对象；`content` 可为 JSON 字符串或已解析对象 |
| 单作业内容 | `doc.title` 缺失回退“未命名作业”；`opers`/`groups` 拼成“名字、[组名]”；无展示项为“未知” |
| 作业集成员 | `data.copilot_ids` 接受数字或数字字符串；丢弃 0、负数、小数与重复项 |
| 作业集计划 | `items` 与 `entries` 必须同时存在；`completed` 条目按 `itemIndex` 折叠为 `completedModes`；`stage` 缺失时名称回退“作业 #id” |
| 搜索结果 | 接受信封/原始载荷；缺 `uri` 的条目丢弃；`recommended` 只有带 `uri` 才自动填充；`views`/`hotScore` 缺失按 0 |
| 旧探测 | `prts://<id>` 的“自动”模式按单作业处理，不会猜测同 id 作业集；prts.plus 链接继续探测 |
| 执行 | raid `1`/`2` 规范化为 `raid`/`both`；未带 s 前缀的作业集在预览与执行时补 `prts://s<id>` |

服务端端点保持兼容；配置 key、本地存储键、pending 与 wire 形状由[配置持久化协调器](config-persistence.md)统一定义。搜索与预览应继续经过领域 Query 和预览会话，不在页面重建请求状态机。

## 7. Activity 与卸载

- Query 观察者随 Effect 清理注销；在途读取通过 `signal` 取消，缓存保留并按 `gcTime` 回收。
- 预览会话 `stop()` 取消在途读取并结束 loading，保留已显示预览；恢复 `start()` 不自动重放。
- 搜索 hook 在清理时取消在途搜索；恢复后不自动重放，成功结果仍可从 Query 缓存读取。
- 真正卸载后重挂载会重置搜索词、识别方式与选中索引；Query 缓存若仍新鲜可直接复用。切换作业类型只卸载卡片 DOM，工作区持有的面板会话存储会保留这些局部输入。
- 后台 Run 与配置提交不依赖本页 Activity；隐藏不会改变运行所有权。

## 8. 回归测试

| 文件 | 覆盖 |
| --- | --- |
| `client/src/features/combat/model/copilotPayload.test.ts` | 搜索/悖论载荷、PRTS 代理字符串/对象 content、缺失标题、成员 id 兼容、计划 completedModes 与非法载荷 |
| `client/src/features/combat/model/copilotPreview.test.ts` | 自动/单个/作业集目标解析、prts.plus 探测、s 前缀、预览对象与旧兜底 |
| `client/src/features/combat/model/copilotSelection.test.ts` | 去重排序、待执行求差、突袭/两者/预设编队、本地选择与计划求交、全选/清空 |
| `client/src/features/combat/model/combatCommands.test.ts` | 高级参数表、编队/突袭规则、set 前缀改写、set options、app/cli 映射、输入校验 |
| `client/src/features/combat/model/queries.test.ts` | 资源 key、signal 传递与取消、失败分类、计划优先/成员回退、探测、强制刷新 |
| `client/src/features/combat/model/copilotPreviewSession.test.ts` | loading/ready、旧响应取消、tracked key 取消、Activity 停止/恢复、静默刷新、进度视图 |
| `client/src/features/combat/utils/copilotUri.test.ts` | prts://、prts.plus、本地文件、多行输入与不支持输入 |
| `client/src/pages/combat/CombatTasks.test.tsx` | 搜索/预览旧响应与 AbortSignal、选择写入配置并提交选中索引、预览失败保留旧预览、搜索失败消息、搜索结果与运行状态隔离、Activity 恢复清 loading、配置与执行既有回归 |

针对性命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client exec vitest run src/features/combat src/pages/combat
```
