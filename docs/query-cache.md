# Query 缓存与键规范

> [← 返回文档索引](README.md)

本文描述 FPR-017 交付的应用级 TanStack Query 基础设施：客户端与 Provider 的创建位置、默认重取/重试策略、领域 query key 约定、失效方式，以及它与 Zustand、配置草稿、执行控制器和 Dashboard 完整快照的边界。

当前已交付基础设施，并由 FPR-019 完成数据统计页的首个迁移、FPR-044 完成养成候选列表与状态计数查询、FPR-021 完成养成队列的读取与写入命令。其余页面按资源任务逐步接入。资源请求的取消、信封与载荷校验契约见[资源请求错误与取消契约](resource-requests.md)，配置草稿与运行身份分别见[配置持久化协调器](config-persistence.md)与[前端执行客户端与控制器](execution-client.md)。

## 1. 定位与边界

Query 缓存只保存**服务端只读资源**的最近一次成功结果，不拥有任何可写状态。

| 内容 | 唯一归属 | 与 Query 的关系 |
| --- | --- | --- |
| Query 客户端、默认策略、key 工厂与 Provider | `shared/query/`、`app/providers/` | 本文 |
| 各域资源的 query key、queryFn、启用条件与失效触发 | 资源所属 feature 或跨域微域 | 用 `defineQueryKeys` 创建 key，经域公开面导出 |
| 配置草稿、pending 标记、提交队列 | `features/user-config/` 协调器 | 不进入 Query；提交成功后再失效相关资源 |
| 运行身份、快照观察、停止与恢复 | `features/task-execution/` 控制器 | 不进入 Query；`runs/current`、`tasks/status` 不是普通资源 |
| 跨页客户端状态（主题、连接健康、运行投影、预览偏好、面板选择） | 对应 Zustand store 或域内状态 | 不复制 Query 数据 |
| Dashboard 完整业务快照 | Dashboard 刷新协调器 + `dashboardStore` | 可读取 Query，但只在完整快照通过校验后原子提交 |
| 实时日志、WebRTC 信令等会话 | 对应会话所有者 | 不因接入 Query 改变暂停/恢复与取消语义 |

关键约束：

- **同一服务端资源只有 Query 缓存一份可写真相。** 页面可以派生筛选、展开、选中项等 UI 状态，但不得把资源数据复制进 Zustand 或第二份组件状态后分别修改。
- **配置草稿不是资源缓存。** 编辑中的草稿属于 user-config 协调器；Query 中的服务端副本不参与草稿合并，提交成功后才由适配器或页面失效相关 key。
- **Query 不接管长任务。** 执行提交、停止、轮询观察和恢复仍归 task-execution 控制器；不要把 Run 快照放进 Query 缓存当作运行状态机。
- **写入不依靠 Query mutation 自动重试。** 默认 `mutations.retry = false`；配置与执行写入继续走既有协调器/控制器。

## 2. 应用级客户端与 Provider

| 入口 | 位置 | 行为 |
| --- | --- | --- |
| `getQueryClient()` | `shared/query/queryClient.ts` | 懒创建并复用应用级唯一客户端；页面、Activity 或 Provider 重建都不换客户端（缓存是否过期由 `staleTime`/`gcTime` 决定） |
| `createQueryClient()` | 同上 | 每次返回独立客户端；只用于测试或隔离环境 |
| `QueryProvider` | `app/providers/QueryProvider.tsx` | `QueryClientProvider` 注入应用级客户端 |
| `AppProviders` | `app/providers/AppProviders.tsx` | 在 `MotionConfig` 外组装 `QueryProvider`，整个应用只有一个 Provider |

规则：

- 页面、领域 hook 与微域**不得**自行 `new QueryClient()` 或嵌套 `QueryClientProvider`；需要测试隔离时使用 `createQueryClient()` 并显式注入测试树。
- 应用级 hook（执行观察、运行状态投影、后端探针）在 `AppShell`/`AppProviders` 内运行；后续接入 Query 时可直接使用客户端上下文，不得在 Provider 外的根组件调用 `useQuery`。
- 页面卸载、Activity 隐藏/恢复与浏览器刷新不调用 `queryClient.clear()`；缓存按 `gcTime` 自然回收，只有测试或明确的全局重置入口可以主动清空。
- 客户端内部使用 TanStack Query 的默认 query hash 与结构共享，不额外包装 key 序列化。

回归：`app/providers/AppProviders.test.tsx` 验证应用树拿到同一客户端；`app/providers/QueryProvider.test.tsx` 验证 Provider 重建、页面 remount，以及 Activity 隐藏后观察者注销、新鲜数据直接复用、过期数据重取与超过 `gcTime` 后重新加载。

## 3. 默认查询策略

默认值在 `shared/query/queryClient.ts` 的 `queryDefaultOptions` 中集中定义，测试锁定这些数值：

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `staleTime` | 30s | 新鲜期内 remount、Activity 恢复与重连不重复请求；过期不等于清空缓存 |
| `gcTime` | 5min | 最后一个观察者离开后保留缓存；Activity 隐藏会注销观察者并开始计时，隐藏超过该时长后缓存被回收 |
| `refetchOnMount` | `true` | 页面 remount 或 Activity 恢复后重新订阅时，过期数据后台重取；新鲜则直接使用缓存 |
| `refetchOnWindowFocus` | `false` | 文档重新可见时不自动重取；Activity 隐藏已清理观察者，恢复取数由 `refetchOnMount`/显式 refetch 负责 |
| `refetchOnReconnect` | `true` | 网络恢复时重取过期资源，并继续被暂停的读取 |
| `retry` | `shouldRetryQuery` | 最多 2 次重试（共 3 次尝试），只重试可恢复失败 |
| `retryDelay` | 500ms 指数退避 | 单次等待上限 4s |
| `networkMode` | `online` | 离线时暂停读取，恢复在线后继续 |
| `mutations.retry` | `false` | 写请求不自动重试 |

重试分类与[资源请求错误与取消契约](resource-requests.md)一致：

| 失败 | 是否重试 |
| --- | --- |
| `ApiRequestError.kind === 'transport'` | 是，且不超过次数上限 |
| `kind === 'api'` 且 `retryable === true` | 是，且不超过次数上限 |
| `kind === 'contract'` | 否；载荷或信封错误重试不会变好 |
| `kind === 'api'` 且 `retryable === false` | 否 |
| 非 `ApiRequestError` 的未知错误 | 否，避免掩盖程序错误 |
| `AbortError`（调用方取消） | 否；取消不记为失败，也不触发重试 |

说明：

- TanStack Query 5.104 的“窗口焦点”实际监听文档可见性（`visibilitychange`）；切换应用内 tab 不产生该事件。React 19.3 的 Activity 隐藏会清理 Effects（见[前端职责与质量基线](frontend-baseline.md)的 Activity 说明），Query 观察者随之注销，因此 `refetchOnWindowFocus: false` 只避免浏览器切回时自动重取仍挂载的查询，不能阻止 Activity 恢复后的按需重取。
- Activity 隐藏/恢复与页面卸载对 Query 订阅是等价的：隐藏清理观察者，缓存从最后一个观察者离开时开始按 `gcTime` 计时；显示后重新订阅。数据仍新鲜则直接用缓存，已过期则按 `refetchOnMount` 后台重取，已被回收则重新加载。
- 网络在线状态来自浏览器 `navigator.onLine`，不代表本地后端可用；后端健康仍由 runtime-status 监测。后端不可用表现为传输失败，由重试与页面错误边界处理。
- 需要更短或更长新鲜期的资源可在自己的 `useQuery` 中覆盖 `staleTime`，但必须在所属域说明理由；不得在页面里改动全局默认值。
- 轮询资源（例如设备采样）如果使用 Query，必须由所属域显式设置 `refetchInterval` 与可见性/暂停条件，不能依赖全局默认值产生后台轮询；实时日志等既有会话继续由对应任务决定实现方式。
- 需要强制读取最新值的流程（例如 Dashboard 的强制刷新、计划生成前重读 queue）使用 `staleTime: 0` 的 `fetchQuery` 或显式 `refetch`，不能依赖默认 `staleTime`。

## 4. Query key 约定

所有资源 key 统一为：

```
[domain, resource, ...params]
```

| 段 | 含义 | 规则 |
| --- | --- | --- |
| `domain` | 资源所属域 | 与 feature/微域标识一致，是域级失效作用域；资源迁域时必须由迁移任务给出旧 key 兼容与失效范围 |
| `resource` | 域内资源名 | 稳定语义名（如 `depot`、`queue`、`version`），不用函数名、端点路径或页面名 |
| `params` | 影响响应内容的输入 | 按固定顺序展开；缺失值统一为 `null` 或省略，不能同时出现 `undefined` 与省略两种身份 |

域内用 `defineQueryKeys` 创建 key，不从调用点手写数组：

```ts
import { defineQueryKeys } from '@/shared/query'

// 键模块位于资源所属域，经该域 index.ts 导出。
export const statisticsKeys = defineQueryKeys('statistics')

statisticsKeys.all                      // ['statistics']：整域作用域
statisticsKeys.resource('depot')        // ['statistics', 'depot']：资源作用域
statisticsKeys.query('drops', 7)        // ['statistics', 'drops', 7]：具体缓存身份
```

key 中只放服务端资源身份：筛选/排序等会改变响应的输入放在 `params`，展开、选中、弹层、分页游标等纯 UI 状态不进入 Query key。`domain` 与 `resource` 必须唯一归属一个域；同名资源在两个域各建缓存属于两个真相，必须避免。

预留给后续资源任务的命名（最终归属以各任务为准，但不得为同一资源另起 key）：

| 域 | 预留资源 | 归属任务 |
| --- | --- | --- |
| `game-data` | `depot`、`operbox`、`catalog` | FPR-018 交付归属；statistics 页面读取由 FPR-019 迁移；training 只在候选补齐/计数中读取公开端点，不复制 key |
| `statistics` | `drops`（参数 `days`） | FPR-019 已迁移 |
| `training` | `queue`、`candidates`、`counts` | `queue` 由 FPR-021 迁移；`candidates`/`counts` 由 FPR-044 迁移 |
| `settings` | `version`、`config-directory`、`maa-config`（参数 `profileName`） | FPR-024 |
| `combat` | `copilot-search`、`paradox-search`、`copilot`、`copilot-set`、`copilot-set-plan` | FPR-029 |
| `logs` | `files`、`file`（参数 `filePath`、`lines`） | FPR-028 |
| `device-mirror` | `webrtc-status`、`device-stats` | FPR-030 |
| `automation` | `activity`、`schedule-execution` | FPR-030 |
| `dashboard` | `snapshot` | FPR-030 |

## 5. 失效方式

失效是写入成功后的显式动作，不由页面 remount 或 Activity 显示自动触发；Activity 显示可能按新鲜度重取数据，但不会把缓存标记为失效。

```ts
// 只失效一个资源的所有参数变体
await queryClient.invalidateQueries({ queryKey: statisticsKeys.resource('drops') })

// 仅当该域全部资源都受影响时使用域级作用域
await queryClient.invalidateQueries({ queryKey: statisticsKeys.all })
```

规则：

1. **精确优先。** 能定位到资源时用 `keys.resource(...)`，不要用 `keys.all` 或 `queryClient.clear()` 代替。
2. **写成功后失效。** 只有服务端写入确认成功才失效受影响 key；失败保留旧缓存，页面展示自己的错误。部分成功的域（如配置已保存、schedule 失败）只失效已确认的资源，并保留 pending 草稿。
3. **跨域影响由领域端口发布。** 识别、应用计划、资源更新等跨域影响由 `features/resource-invalidation` 的失效发布/接收端协调（FPR-018 交付，见[共享资源归属与失效端口](resource-ownership.md)），Query 层不增加全局失效总线或页面间轮询。
4. **失效失败不阻塞写入。** `invalidateQueries` 的重取失败保留旧数据；页面需要区分“旧数据 + 重取失败”和“从未加载”。
5. **不写入部分快照。** 只有响应是权威完整资源时才允许 `setQueryData`；不做覆盖多个 key 的逐块乐观写入。唯一例外是养成队列命令在**写入已成功、写后刷新失败**时写入的本地 fallback：它不是服务端快照，必须携带 `uncertain` 标记与已知 revision，下次权威读取会清除标记（见[养成队列命令与写后刷新](training-queue-commands.md)）。

## 6. Activity、重连与生命周期

| 事件 | Query 行为 | 页面责任 |
| --- | --- | --- |
| Activity 隐藏 | 清理 Effects，Query 观察者注销；缓存保留并从最后一个观察者离开时开始按 `gcTime` 计时。若 queryFn 使用了 `signal`，最后一个观察者离开时在途读取被取消并保留上一份数据 | 不得假设隐藏期间观察者仍存活或缓存一定保留；需要跨隐藏持续观察的资源由应用级所有者持有 |
| Activity 显示 | 重新订阅；数据仍新鲜则直接用缓存，已过期则按 `refetchOnMount` 后台重取，已被 `gcTime` 回收则重新加载 | 需要最新快照时显式 `refetch`；不能依赖隐藏期间的观察者 |
| 浏览器文档隐藏/可见 | `refetchOnWindowFocus: false`，不自动重取 | 实时会话按既有可见性规则暂停/恢复 |
| 页面真正卸载后重挂载 | 观察者注销，缓存保留到 `gcTime`；新鲜则直接用缓存，过期则后台重取，已回收则重新加载 | 不得在 effect cleanup 清空 queryClient 或删除其他页面的 key |
| 浏览器刷新 | 内存缓存丢失；Dashboard 持久化快照仍按自身规则恢复 | 首屏骨架与旧数据展示保持各页现有行为 |
| 网络离线/恢复 | 离线读取暂停；恢复后重取过期资源 | 连接健康仍由 runtime-status 展示，不从 Query 状态推断任务完成 |
| 调用方取消 | `AbortError` 不重试、不记为失败 | 页面只在真正失败时展示错误 |

Activity 隐藏/显示与页面卸载都不改变资源所有权；Query 缓存按 key 共享，但观察者随 Effect 清理而注销。使用 Query 的 `signal` 读取在最后一个观察者离开时会被取消（Query 以 revert 方式保留上一份数据）；未使用 signal 的请求可能继续完成并写入缓存。接入契约要求 `queryFn` 传递 `signal`，因此应按“隐藏/卸载即取消本地读取、旧数据保留”设计。显式 `cancelQueries` 用于切换资源或放弃缓存写入，不作为 Activity 生命周期的替代。

## 7. Dashboard 完整快照边界

Dashboard 的五路业务读取（activity、schedule execution、training queue、today drops、open-today stages）是一个**完整快照**，不是五个可独立展示的资源块。接入 Query 后仍必须满足[配置同步与资源一致性契约](config-sync-and-invalidation.md)第 4 节：

- 五项都 fulfilled 且载荷校验通过才提交快照；
- 单路失败或形状错误保留上一份完整快照，不能用 Query 的部分成功覆盖 store；
- 设备采样与后端探测独立于业务快照有效性；
- 强制刷新必须显式重取；Activity 恢复若需要新的完整快照，不能接受默认缓存命中，需显式重取或验证数据新鲜度。

因此允许的实现是：用 Query 或既有协调器取得五路结果，在协调层统一校验后原子写入 `dashboardStore`；**禁止**五个 `useQuery` 分别订阅并各自写 store，也禁止把 Query 的逐块更新暴露成新的可写真相。`dashboard/snapshot` key 仅用于协调读取，不能替代 `dashboardStore` 的版本、形状与时钟校验。

## 8. 迁移入口

资源任务接入时：

```ts
const result = await readApiData<DepotPayload>('/api/agent/data/depot', {
  signal,
  validate: isDepotPayload,
})
// queryFn 返回 result.data；失败抛出 ApiRequestError，取消保持 AbortError
```

或保留旧端点函数：

```ts
queryFn: async ({ signal }) => unwrapApiResponse(await getDepotData(signal))
```

- `queryFn` 必须把 Query 的 `signal` 传到 `fetch`，不能只丢弃响应；取消、失败分类与载荷校验沿用[资源请求错误与取消契约](resource-requests.md)。
- 页面现有的 request id/generation guard 保留到 Query 真正接管该读取；已迁移的读取（如数据统计页的四路 query）移除页面 guard，由 Query 的取消与 revert 负责竞态。未迁移页面继续保留，直到回归测试覆盖竞态与取消。
- `enabled` 只表达“当前是否应读取该资源”（例如依赖参数或可见性），不用它替代权限、写入协调或运行状态。
- 配置提交与执行命令继续使用 user-config 协调器和 task-execution 控制器，不新增 Query mutation 作为第二写入路径。
- 迁移必须补充：同 key 共享缓存、失效范围、失败保留旧数据、Activity 隐藏/恢复与真正 remount 的回归。

## 9. 已迁移页面：数据统计（FPR-019）

`DataStatistics` 是首个接入 Query 的页面。四路读取由领域 query 定义持有，页面不再保存资源副本、加载状态或 request id：

| 资源 | query 定义 | 首屏启用 | 刷新方式 | 错误边界 |
| --- | --- | --- | --- | --- |
| 仓库快照 | `game-data` 的 `depotQueryOptions()` | 是 | 重试按钮 `refetch`；识别解析成功后 `setQueryData` 写入完整快照；收到 `depot` 失效 | 独立错误面板，不阻塞干员/掉落 |
| 持有干员 | `operBoxQueryOptions()` | 是 | 重试 `refetch`；干员识别解析成功后 `setQueryData`；收到 `operbox` 失效 | 与目录错误合并为干员面板错误 |
| 干员目录 | `operatorCatalogQueryOptions()` | 是 | 重试 `refetch`；收到 `catalog` 失效（材料刷新不改变目录，不再额外重读） | 与持有干员错误合并为干员面板错误 |
| 掉落统计 | `statistics` 的 `dropStatisticsQueryOptions(days)` | 是 | 天数切换使用独立 key；刷新/重试 `refetch`；收到 `drops` 失效 | 独立错误面板，刷新失败保留上次成功数据 |

- 四路 query 在页面挂载时同时启用，不依赖当前 tab；切 tab 只改变渲染，不重建查询。
- 缓存策略保持第 3 节默认值：30s 内页面重挂载或 Activity 恢复直接复用；过期后台重取；无观察者超过 5min 后重新加载。
- 页面持有筛选与排序状态（一个 `OperatorFilters` 对象），不放在条件挂载的 tab 面板内，因此切 tab 不丢状态。筛选、排序与阿米娅形态规则由 `features/statistics/model/operatorFilters.ts` 纯函数实现并直接测试。
- 识别解析结果作为权威完整快照写入 Query 缓存；命令所有者（FPR-020）在解析成功后由 `resource-invalidation` 声明影响范围，页面按作用域失效，不建立第二份本地状态。识别命令本身不进入 Query，也不由 Query 自动重试；超时/取消后的继续方式见[统计识别命令与失效联动](statistics-commands.md)。
- 切换掉落天数时使用 `keepPreviousData` 占位，旧周期内容在加载期间保持可见；新 key 首次失败只展示错误，不伪造上一个周期的数据。

## 10. 已迁移读取：养成队列、候选与状态计数（FPR-021/044）

`OperatorTraining` 的队列、候选列表与三种状态计数都由 training 领域 query 持有，页面只读取 query 结果；设置与计划仍沿用页面状态（分别由 FPR-022/023 迁移）。队列写入由 `queueCommands` 领域命令串行执行，写成功后把权威快照写入同一 `queue` key，见[养成队列命令与写后刷新](training-queue-commands.md)。

| 资源 | query 定义 | 缓存身份 | 失败语义 | 刷新方式 |
| --- | --- | --- | --- | --- |
| 队列 | `trainingQueueQueryOptions()` | `['training','queue']` | query error；页面展示可重试错误；写入成功但写后刷新失败时保留带 `uncertain` 的本地 fallback | 首屏/remount 按默认策略；收到 `depot`/`operbox`/`materials`/`training-queue` 外部失效后重读；计划生成前、重试同步后与“重新加载”显式 `refetch`；队列命令自行做写后刷新 |
| 候选列表 | `trainingCandidatesQueryOptions(filters)` | `['training','candidates',status,rarity,needsElite2]` | query error；页面清空列表并展示可重试错误 | 筛选切换使用独立 key；收到 `depot`/`operbox`/`catalog`/`materials` 失效后 `invalidateQueries`；重试按钮 `refetch` |
| 三种计数 | `trainingStatusCountsQueryOptions(filters)` | `['training','counts',rarity,needsElite2]` | 不展示错误；同 key 失败保留上次成功值 | 同上作用域失效；`placeholderData: keepPreviousData` 让筛选切换期间保留旧计数 |

规则：

- 队列只有一个可写真相：页面不保存第二份队列副本；命令执行时读取缓存中的最新快照，写前取消在途读取，写成功后重新读取权威队列。重复的同类命令在 pending 期间合并。
- 队列写入成功但刷新失败时，命令在最新缓存上应用本地 fallback 并标记 `uncertain`；页面据此禁用计划预览/应用，重新加载成功后清除。写入失败不修改缓存、不发布失效。
- 队列命令发布 `training-queue`/`materials`/`training-plan`/`dashboard-snapshot`，并携带 `detail.source`；本页忽略自己的发布，外部 `training-queue` 发布仍触发重读。
- 候选 `status=all` 且端点返回空列表时，沿用旧兼容补齐：在同一 queryFn 内读取 `game-data` 的目录与持有干员公开端点，不建立第二套 key；其它状态直接使用端点行。
- 计数保持迁移前来源：`trainable`/`owned` 取候选端点行数，`owned` 为空时回退持有干员快照，`all` 取目录按稀有度过滤后的行数（不应用“未精二”）。计数为 0 的 `all` 不覆盖旧值，由 `structuralSharing` 调用 `mergeTrainingStatusCounts` 保持引用稳定，避免 `keepPreviousData` 占位反复通知。
- `training-queue` 失效只重读队列，不重取候选/计数；`training-plan` 失效作废旧计划预览。队列写入后不使候选/计数失效。
- 筛选切换由 key 隔离，旧 key 的迟到响应只写入旧 key；Activity 隐藏会注销观察者并取消本地读取，恢复时按新鲜度重取。

## 11. 回归证据

| 文件 | 覆盖 |
| --- | --- |
| `client/src/shared/query/queryClient.test.ts` | 默认 staleTime/gcTime/重取/网络模式、重试分类与上限、退避、写请求不重试、工厂隔离与应用级单例 |
| `client/src/shared/query/queryKeys.test.ts` | `[domain, resource, ...params]` 形状、同域 key 结构一致、域级与资源级失效范围 |
| `client/src/app/providers/QueryProvider.test.tsx` | Provider 重建保留同一缓存、同 key 单次请求与共享缓存、页面卸载/重挂载；Activity 隐藏后观察者注销、新鲜数据复用、超过 staleTime 重取、超过 gcTime 回收后重新加载；文档焦点不重取、重连重取过期资源 |
| `client/src/app/providers/AppProviders.test.tsx` | 应用树注入应用级客户端 |
| `client/src/app/App.test.tsx` | 应用级 hook 在 `AppProviders` 内运行并能拿到 Query 客户端 |
| `client/src/features/game-data/model/queryKeys.test.ts` | `game-data` 域名与 `depot`/`operbox`/`catalog` 资源作用域 |
| `client/src/features/game-data/model/queries.test.ts` | 共享资源 key、空快照保留、载荷归一、失败转为 query 错误、signal 传递 |
| `client/src/features/statistics/model/queries.test.ts` | `drops` 的 `days` 缓存身份、`keepPreviousData`、失败转为 query 错误、signal 传递 |
| `client/src/features/training/model/candidates.test.ts` | 候选旧载荷、`all` 补齐、计数来源与 `all=0` 保留、结构共享引用稳定 |
| `client/src/features/training/model/queueCommands.test.ts` | 队列命令串行与最新快照排序、重复添加合并、写后刷新失败 fallback/`uncertain`、失败不提交不发布、撤销原索引、目标失效拒绝、写前取消读取 |
| `client/src/features/training/model/queries.test.ts` | `queue`/`candidates`/`counts` key 与参数、signal、失败信封、补齐读取与计数结构共享 |
| `client/src/features/training/pages/OperatorTraining.test.tsx` | 队列读取与写入命令接线、计数展示、列表失败清空/计数保旧、筛选迟到响应、失效范围、Activity 隐藏恢复、写后刷新失败与跨页失效 |
| `client/src/features/statistics/model/commandOwner.test.ts` | 识别/材料命令的控制器 intent、幂等复用、解析等待、超时/取消/继续与失效发布；识别命令不进入 Query |
| `client/src/features/statistics/pages/DataStatistics.layout.test.tsx` | 四路首屏并行、共享缓存与 remount、按作用域失效、独立错误边界、识别写入缓存、筛选与 tab 生命周期、Activity 隐藏/恢复取消旧读取 |
| `client/src/features/resource-invalidation/model/resourceInvalidation.test.ts` | 跨域失效发布、作用域 revision、注销与监听器异常隔离 |
| `client/src/features/resource-invalidation/hooks/useResourceInvalidation.test.tsx` | 订阅过滤、Activity 隐藏/恢复补发、卸载注销与最新 handler |

针对性复现命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client exec vitest run \
  src/shared/query/queryClient.test.ts \
  src/shared/query/queryKeys.test.ts \
  src/app/providers/QueryProvider.test.tsx \
  src/app/providers/AppProviders.test.tsx \
  src/app/App.test.tsx \
  src/features/game-data/model/queryKeys.test.ts \
  src/features/game-data/model/queries.test.ts \
  src/features/statistics/model/queries.test.ts \
  src/features/statistics/model/operatorFilters.test.ts \
  src/features/training/model/candidates.test.ts \
  src/features/training/model/queueCommands.test.ts \
  src/features/training/model/queries.test.ts \
  src/features/training/pages/OperatorTraining.test.tsx \
  src/features/statistics/pages/DataStatistics.layout.test.tsx \
  src/features/resource-invalidation/model/resourceInvalidation.test.ts \
  src/features/resource-invalidation/hooks/useResourceInvalidation.test.tsx
```

完整 `pnpm verify` 与视觉比对由任务完成记录给出；本文件不重复声称未执行的验证。

## 关联

- [资源请求错误与取消契约](resource-requests.md)：signal、失败分类与载荷校验。
- [养成队列命令与写后刷新](training-queue-commands.md)：队列唯一可写真相、串行命令、写后刷新与不确定 fallback。
- [配置同步与资源一致性契约](config-sync-and-invalidation.md)：跨页失效关系与 Dashboard 完整快照规则。
- [配置持久化协调器](config-persistence.md)：草稿、pending 与完整提交。
- [前端执行客户端与控制器](execution-client.md)：Run 身份、观察与停止。
- [前端职责与质量基线](frontend-baseline.md)：八页职责与 Activity 生命周期。
