# Query 缓存与键规范

> [← 返回文档索引](README.md)

本文描述 FPR-017 交付的应用级 TanStack Query 基础设施：客户端与 Provider 的创建位置、默认重取/重试策略、领域 query key 约定、失效方式，以及它与 Zustand、配置草稿、执行控制器和 Dashboard 完整快照的边界。

当前只交付基础设施，页面读取尚未迁移；后续资源任务按本文接入。资源请求的取消、信封与载荷校验契约见[资源请求错误与取消契约](resource-requests.md)，配置草稿与运行身份分别见[配置持久化协调器](config-persistence.md)与[前端执行客户端与控制器](execution-client.md)。

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
| `getQueryClient()` | `shared/query/queryClient.ts` | 懒创建并复用应用级唯一客户端；页面、Activity 或 Provider 重建都不换缓存 |
| `createQueryClient()` | 同上 | 每次返回独立客户端；只用于测试或隔离环境 |
| `QueryProvider` | `app/providers/QueryProvider.tsx` | `QueryClientProvider` 注入应用级客户端 |
| `AppProviders` | `app/providers/AppProviders.tsx` | 在 `MotionConfig` 外组装 `QueryProvider`，整个应用只有一个 Provider |

规则：

- 页面、领域 hook 与微域**不得**自行 `new QueryClient()` 或嵌套 `QueryClientProvider`；需要测试隔离时使用 `createQueryClient()` 并显式注入测试树。
- 页面卸载、Activity 隐藏/恢复与浏览器刷新不调用 `queryClient.clear()`；只有测试或明确的全局重置入口可以清空。
- 客户端内部使用 TanStack Query 的默认 query hash 与结构共享，不额外包装 key 序列化。

回归：`app/providers/AppProviders.test.tsx` 验证应用树拿到同一客户端；`app/providers/QueryProvider.test.tsx` 验证 Provider 重建、页面 remount 与 Activity 隐藏/恢复后仍是同一缓存实例。

## 3. 默认查询策略

默认值在 `shared/query/queryClient.ts` 的 `queryDefaultOptions` 中集中定义，测试锁定这些数值：

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `staleTime` | 30s | 新鲜期内 remount、重连与活动恢复不重复请求；过期不等于清空缓存 |
| `gcTime` | 5min | 最后一个观察者离开后保留缓存；Activity 隐藏仍保留观察者，不受此值影响 |
| `refetchOnMount` | `true` | 真正 remount 时若数据已过期则后台重取；新鲜则直接使用缓存 |
| `refetchOnWindowFocus` | `false` | 文档重新可见时不自动重取；避免 Activity 隐藏页面集体刷流量 |
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

- TanStack Query 5.104 的“窗口焦点”实际监听文档可见性（`visibilitychange`）；切换应用内 tab 不产生该事件。Activity 隐藏页面仍保留 Query 观察者，`false` 保证回到浏览器时不会让所有页面同时重取。
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
| `statistics` | `depot`、`operbox`、`catalog`、`drops`（参数 `days`） | FPR-018 / FPR-019 |
| `training` | `queue`、`candidates`、`counts` | FPR-021 / FPR-044 |
| `settings` | `version`、`config-directory`、`maa-config`（参数 `profileName`） | FPR-024 |
| `combat` | `copilot-search`、`paradox-search`、`copilot`、`copilot-set`、`copilot-set-plan` | FPR-029 |
| `logs` | `files`、`file`（参数 `filePath`、`lines`） | FPR-028 |
| `device-mirror` | `webrtc-status`、`device-stats` | FPR-030 |
| `automation` | `activity`、`schedule-execution` | FPR-030 |
| `dashboard` | `snapshot` | FPR-030 |

## 5. 失效方式

失效是写入成功后的显式动作，不由页面 remount 或 Activity 显示自动触发。

```ts
// 只失效一个资源的所有参数变体
await queryClient.invalidateQueries({ queryKey: statisticsKeys.resource('drops') })

// 仅当该域全部资源都受影响时使用域级作用域
await queryClient.invalidateQueries({ queryKey: statisticsKeys.all })
```

规则：

1. **精确优先。** 能定位到资源时用 `keys.resource(...)`，不要用 `keys.all` 或 `queryClient.clear()` 代替。
2. **写成功后失效。** 只有服务端写入确认成功才失效受影响 key；失败保留旧缓存，页面展示自己的错误。部分成功的域（如配置已保存、schedule 失败）只失效已确认的资源，并保留 pending 草稿。
3. **跨域影响由领域端口发布。** 识别、应用计划、资源更新等跨域影响由 FPR-018 交付的失效发布/接收端协调，Query 层不增加全局失效总线或页面间轮询。
4. **失效失败不阻塞写入。** `invalidateQueries` 的重取失败保留旧数据；页面需要区分“旧数据 + 重取失败”和“从未加载”。
5. **不写入部分快照。** 只有响应是权威完整资源时才允许 `setQueryData`；不做覆盖多个 key 的逐块乐观写入。

## 6. Activity、重连与生命周期

| 事件 | Query 行为 | 页面责任 |
| --- | --- | --- |
| 应用内 tab 切换（Activity 隐藏/显示） | 隐藏不销毁观察者与缓存，显示不触发失效或全量重取 | 需要刷新时由域显式调用 `refetch` 或失效，不能依赖 Activity 的显示事件 |
| 浏览器文档隐藏/可见 | `refetchOnWindowFocus: false`，不自动重取 | 实时会话按既有可见性规则暂停/恢复 |
| 页面真正卸载后重挂载 | 缓存保留到 `gcTime`；新鲜则直接用缓存，过期则后台重取 | 不得在 effect cleanup 清空 queryClient 或删除其他页面的 key |
| 浏览器刷新 | 内存缓存丢失；Dashboard 持久化快照仍按自身规则恢复 | 首屏骨架与旧数据展示保持各页现有行为 |
| 网络离线/恢复 | 离线读取暂停；恢复后重取过期资源 | 连接健康仍由 runtime-status 展示，不从 Query 状态推断任务完成 |
| 调用方取消 | `AbortError` 不重试、不记为失败 | 页面只在真正失败时展示错误 |

Activity 隐藏只清理 Effects，不改变资源所有权；Query 缓存跨页面实例共享。真正卸载页面不会取消已发出的读取（TanStack 允许请求完成并写入缓存），需要放弃某个资源读取时由所属域显式 `cancelQueries` 并说明缓存语义。

## 7. Dashboard 完整快照边界

Dashboard 的五路业务读取（activity、schedule execution、training queue、today drops、open-today stages）是一个**完整快照**，不是五个可独立展示的资源块。接入 Query 后仍必须满足[配置同步与资源一致性契约](config-sync-and-invalidation.md)第 4 节：

- 五项都 fulfilled 且载荷校验通过才提交快照；
- 单路失败或形状错误保留上一份完整快照，不能用 Query 的部分成功覆盖 store；
- 设备采样与后端探测独立于业务快照有效性；
- 强制刷新与 Activity 恢复使用显式重取，不能用默认缓存命中冒充新快照。

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
- 页面现有的 request id/generation guard 保留到 Query 真正接管该读取；接管后只有在回归测试覆盖竞态与取消时才移除。
- `enabled` 只表达“当前是否应读取该资源”（例如依赖参数或可见性），不用它替代权限、写入协调或运行状态。
- 配置提交与执行命令继续使用 user-config 协调器和 task-execution 控制器，不新增 Query mutation 作为第二写入路径。
- 迁移必须补充：同 key 共享缓存、失效范围、失败保留旧数据、Activity 隐藏/恢复与真正 remount 的回归。

## 9. 回归证据

| 文件 | 覆盖 |
| --- | --- |
| `client/src/shared/query/queryClient.test.ts` | 默认 staleTime/gcTime/重取/网络模式、重试分类与上限、退避、写请求不重试、工厂隔离与应用级单例 |
| `client/src/shared/query/queryKeys.test.ts` | `[domain, resource, ...params]` 形状、同域 key 结构一致、域级与资源级失效范围 |
| `client/src/app/providers/QueryProvider.test.tsx` | Provider 重建保留同一缓存、同 key 单次请求与共享缓存、页面卸载/重挂载、Activity 隐藏/显示、文档焦点不重取、重连重取过期资源 |
| `client/src/app/providers/AppProviders.test.tsx` | 应用树注入应用级客户端 |

针对性复现命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client exec vitest run \
  src/shared/query/queryClient.test.ts \
  src/shared/query/queryKeys.test.ts \
  src/app/providers/QueryProvider.test.tsx \
  src/app/providers/AppProviders.test.tsx
```

完整 `pnpm verify` 与视觉比对由任务完成记录给出；本文件不重复声称未执行的验证。

## 关联

- [资源请求错误与取消契约](resource-requests.md)：signal、失败分类与载荷校验。
- [配置同步与资源一致性契约](config-sync-and-invalidation.md)：跨页失效关系与 Dashboard 完整快照规则。
- [配置持久化协调器](config-persistence.md)：草稿、pending 与完整提交。
- [前端执行客户端与控制器](execution-client.md)：Run 身份、观察与停止。
- [前端职责与质量基线](frontend-baseline.md)：八页职责与 Activity 生命周期。
