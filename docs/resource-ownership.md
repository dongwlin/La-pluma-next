# 共享资源归属与失效端口

> [← 返回文档索引](README.md)

本文描述 FPR-018 交付的共享资源归属与跨域失效端口。它回答三件事：仓库、持有干员、干员目录这些被多个页面消费的服务端读取由谁持有；training 与 statistics 之间原先的双向 API 依赖如何解开；识别、计划应用和资源更新等写入成功后，尚未迁移到 Query 的页面如何通过稳定端口刷新。

相关契约：[资源请求错误与取消契约](resource-requests.md)、[Query 缓存与键规范](query-cache.md)、[配置同步与资源一致性契约](config-sync-and-invalidation.md)。

## 1. 定位与边界

| 内容 | 唯一归属 | 说明 |
| --- | --- | --- |
| 仓库、持有干员、干员目录的只读端点、载荷类型与 query key | `features/game-data` | 非页面微域；`shared/api` 不新增业务端点 |
| 物品图标 URL | `features/game-data` | 纯 URL 构造，不发起请求、不进入 Query |
| 跨域资源失效发布/订阅 | `features/resource-invalidation` | 只传资源作用域，不持有资源数据 |
| 养成队列、设置、计划、材料刷新端点 | `features/training` | 队列/设置/计划的写入与领域语义仍归 training；材料刷新的命令编排归 statistics |
| 掉落统计、今日掉落、今日开放关卡、识别/材料命令所有者 | `features/statistics` | 只读掉落/关卡供 Dashboard 使用；统计页读取已由 FPR-019 迁入 Query，识别/材料命令由 FPR-020 交付（见[统计识别命令与失效联动](statistics-commands.md)） |
| Query 客户端、默认策略 | `shared/query` | 见 [Query 缓存与键规范](query-cache.md) |

关键约束：

- **一个共享资源只有一份 API/类型/key 归属。** 页面不得各自声明同义端点或手写 key 数组。
- **共享资源域不是通用后端层。** `game-data` 只收跨页面共享的读取；掉落、开放关卡、队列与计划仍归各自领域。
- **失效端口不是 Query 总线。** 它不保存资源、不自动重取，也不向 `shared/query` 增加全局失效机制；订阅者自行决定刷新或失效范围。
- **不在 Query 与页面状态中维护同一资源的双份可写真相。** 统计页已改由 Query 持有唯一缓存；training 的候选列表与状态计数已由 FPR-044 迁入领域 query（队列/设置/计划仍由页面持有，待 FPR-021/022/023），Dashboard 的完整快照仍待 FPR-030。

## 2. 资源与缓存策略

`game-data` 的 public surface：

```ts
import {
  depotQueryOptions,
  gameDataKeys,
  getAllOperators,
  getDepotData,
  getItemIconUrl,
  getOperBoxData,
  operBoxQueryOptions,
  operatorCatalogQueryOptions,
} from '@/features/game-data'
```

| 资源 | 端点 | 当前读取方 | Query key | 缓存/刷新策略 |
| --- | --- | --- | --- | --- |
| 仓库快照 | `GET /agent/data/depot` | DataStatistics（FPR-019 已迁 Query）；识别后影响养成与总览 | `gameDataKeys.resource('depot')` | Query 默认策略（30s stale、5min gc、可恢复失败重试）；不轮询，识别后显式失效；仅当资源更新重写已识别快照时才额外发布 `depot` |
| 持有干员 | `GET /agent/data/operbox` | DataStatistics（FPR-019 已迁 Query）、OperatorTraining（FPR-044） | `gameDataKeys.resource('operbox')` | 同上；干员识别完成后失效 |
| 干员目录 | `GET /agent/data/operators` | DataStatistics（FPR-019 已迁 Query）、OperatorTraining（FPR-044） | `gameDataKeys.resource('catalog')` | 同上；资源/热更新完成后失效 |
| 物品图标 | 外部静态资源 URL | DataStatistics 仓库、掉落记录、养成材料 | 无 | 浏览器 HTTP/图片缓存；函数只拼 URL。资源更新若复用同一 URL，浏览器可能继续命中旧图，需要变更 URL（版本段）而不是建立 Query key |
| 养成队列（含材料进度） | `/agent/training/queue` 等 | OperatorTraining、Dashboard 快照 | 归 `training`（FPR-021/044） | 仍由 training 领域策略持有；不复制进 `game-data`；识别命令不再为提示文案额外读取 |
| 掉落/开放关卡 | `/agent/drops/*`、`/agent/stages/open-today` | DataStatistics、Dashboard 快照 | 归 `statistics`（`drops` 已由 FPR-019 迁移） | 不进入 `game-data`；Dashboard 只通过完整快照读取 |

FPR-019 已把统计页的仓库、持有干员、目录与掉落读取迁入 Query；`game-data` 与 `statistics` 各自导出 query 定义，页面不再保存资源副本。FPR-020 已把识别/材料命令与发布端接入第 4 节的端口；FPR-044 把训练页的候选列表与三种状态计数迁入 `training` 领域 query，查询内部经 `game-data` 的公开端点读取目录与持有干员，不复制共享 key。Dashboard 的完整快照仍由 FPR-030 迁移。识别命令与完成条件见[统计识别命令与失效联动](statistics-commands.md)。

## 3. 公开面与依赖方向

| 域 | 公开面 | 对共享资源的依赖 |
| --- | --- | --- |
| `game-data` | 共享读取、类型、query 定义与 `gameDataKeys` | 无；只依赖 `shared/api`、`shared/query` |
| `resource-invalidation` | 端口、hook、作用域词汇 | 无业务端点 |
| `training` | 页面、队列读取、材料刷新、计划生成/应用 | 经 `game-data` 读取持有干员/目录/图标 |
| `statistics` | 页面、掉落/开放关卡读取、掉落 query 定义与 `statisticsKeys` | 经 `game-data` 读取仓库/持有干员/目录/图标；保留对 training 队列与材料命令的单向调用 |
| `dashboard` | 页面、快照读取 | 经 training/statistics 读取队列与掉落/开放关卡；经端口接收失效 |

原先的环由两条边构成：

- `training → statistics`：`getOperBoxData`、`getItemIconUrl` 已迁到 `game-data`，training 不再 import statistics。
- `statistics → training`：`getAllOperators` 已迁到 `game-data`；`getTrainingQueue`、`fetchOperatorMaterials` 仍是 training 拥有的队列/材料命令，statistics 保持单向依赖。

因此 training 与 statistics 不再为共享资源互相 import 页面域公开面；statistics → training 是“使用另一个领域的队列/材料命令”，不是共享资源的第二份归属。FPR-041 的依赖护栏应以无环为准，不要求页面域之间零 import。

兼容与移除：

- `getDepotData`、`getOperBoxData`、`getItemIconUrl`、`getAllOperators` 的函数名、位置参数和 `ApiResponse` 形状不变，只更换归属模块。
- 迁移前用仓库内 grep 核对消费者；培训页与统计页、DropRecords 及其测试全部改为 `@/features/game-data` 后，statistics/training 公开面不再转发这些函数。
- 数据格式、端点与存储未变；独立回滚可恢复旧公开面转发与页面 import，不需要迁移服务端数据。
- 若未来再次迁域，必须保留旧 key 的失效范围并给消费者迁移窗口，不能在同一资源上新建第二个 domain key。

## 4. 资源失效端口

```ts
import {
  publishResourceInvalidation,
  subscribeResourceInvalidation,
  getResourceInvalidationRevision,
  useResourceInvalidation,
  type ResourceScope,
} from '@/features/resource-invalidation'

publishResourceInvalidation({
  resources: ['depot', 'materials', 'training-queue', 'dashboard-snapshot'],
  cause: 'recognition',
})
```

| 能力 | 行为 |
| --- | --- |
| `publishResourceInvalidation` | 写入确认成功后发布；空资源列表被忽略；重复作用域合并；同步通知当前订阅者 |
| `subscribeResourceInvalidation` | 注册监听器，返回注销函数；监听器异常不影响其他订阅者 |
| `getResourceInvalidationRevision` | 返回给定作用域中最近一次发布的序号；用于判断隐藏期间是否错过发布 |
| `useResourceInvalidation` | Effect 内订阅；Activity 隐藏/卸载时注销；恢复时若期间有发布，补发一次 `cause: 'activity-resume'` 合成事件；首次挂载不补发 |

作用域：

| 作用域 | 含义 |
| --- | --- |
| `depot` | 仓库识别结果或仓库相关资源变化 |
| `operbox` | 持有干员识别结果变化 |
| `catalog` | 干员目录或资源元数据变化 |
| `materials` | 养成材料数据/派生进度变化 |
| `training-queue` | 队列顺序、成员或进度变化 |
| `training-plan` | 已生成计划的前提（队列版本、材料、设置）变化 |
| `automation-config` | 自动化任务流程配置变化 |
| `automation-schedule` | 服务端定时配置变化 |
| `drops` | 今日掉落记录变化 |
| `open-stages` | 今日开放关卡变化 |
| `dashboard-snapshot` | 总览完整业务快照需要重新取得 |

规则：

1. **写成功后才发布。** 部分失败只发布已确认受影响的作用域；失败本身不发布。
2. **精确列举影响范围。** 不用 `dashboard-snapshot` 代替所有领域作用域；发布者同时列出直接资源与需要完整刷新的聚合入口。
3. **不携带资源数据。** 端口只表达“哪些资源已变化”；`detail` 仅用于提示等附加信息，订阅者必须自行校验。
4. **订阅者不轮询。** 页面挂载时的首屏读取与既有定时刷新保持不变；端口只在写入完成后补一次刷新。
5. **Dashboard 仍原子提交。** Dashboard 只订阅 `dashboard-snapshot`，收到后调用完整快照刷新；五路读取全部有效才提交，单路失败保留旧快照。

## 5. 触发与影响映射

写入方按下表发布；表同时约束 `dashboard-snapshot` 必须随影响总览的写入一起发布。前三行已由 FPR-020 的命令所有者交付。

| 触发 | 应发布作用域 | 归属任务 |
| --- | --- | --- |
| 仓库识别成功并解析完成 | `depot`、`materials`、`training-queue`、`dashboard-snapshot` | FPR-020（已交付） |
| 干员识别成功并解析完成 | `operbox`、`materials`、`training-queue`、`dashboard-snapshot` | FPR-020（已交付） |
| 材料刷新成功 | `materials`、`training-queue`、`dashboard-snapshot` | FPR-020（已交付） |
| 队列增删/排序/撤销成功 | `training-queue`、`materials`、`training-plan`、`dashboard-snapshot` | FPR-021 |
| 养成设置保存成功 | `training-plan`（仅当设置影响计划前提） | FPR-022 |
| 应用养成计划成功 | `automation-config`、`automation-schedule`、`dashboard-snapshot` | FPR-023 |
| 资源/热更新成功 | `catalog`、`materials`、`training-plan`、`dashboard-snapshot` | FPR-026 |

`detail` 可选，例如应用计划时携带 `{ stageCount }`；接收方不得依赖未声明字段。

## 6. 未迁移页面的最小接收

| 页面 | 订阅作用域 | 收到后的最小动作 |
| --- | --- | --- |
| `OperatorTraining` | `depot`、`operbox`、`catalog`、`materials`、`training-queue`、`training-plan` | 计划前提变化时作废本地预览；仓库/材料/队列变化时重读队列；仓库/持有干员/目录/材料变化时失效 `training` 的 `candidates`/`counts` 领域 query（FPR-044）；队列失效不重取候选/计数 |
| `Dashboard` | `dashboard-snapshot` | 调用完整快照刷新（`force`），五项全部有效才提交；单路失败保留旧快照与 `lastUpdate` |
| `DataStatistics` | `depot`、`operbox`、`catalog`、`drops` | 按作用域 `invalidateQueries` 对应资源；识别命令由 `features/statistics` 的命令所有者提交，解析成功后页面写入 Query 快照并发布作用域 |

训练页的队列写入目前仍由页面自身在 mutation 成功后重读，不依赖端口；FPR-021 迁移后改由领域命令与缓存协调持有。候选列表与计数已由 FPR-044 改为 Query 观察者，Activity 隐藏时随 Effect 注销并在恢复时按新鲜度重取。

Activity 语义：隐藏会清理订阅 Effect，期间发布不会直接刷新；恢复时 hook 补发一次合成事件，避免“隐藏期间资源已变化但页面仍显示旧值”。真正卸载后重挂载由页面首屏读取负责，不重放历史事件。

## 7. 回归证据

| 文件 | 覆盖 |
| --- | --- |
| `features/game-data/api/index.test.ts` | 仓库/持有干员/目录的 signal、旧空值、坏载荷、取消；图标 URL 编码且不发请求 |
| `features/game-data/model/queryKeys.test.ts` | `game-data` 域名与 `depot`/`operbox`/`catalog` 资源作用域 |
| `features/game-data/model/queries.test.ts` | 共享读取的 query key、空快照、载荷归一、失败与 signal |
| `features/statistics/model/queries.test.ts`、`features/statistics/model/operatorFilters.test.ts` | 掉落 `days` 缓存身份；筛选、排序与阿米娅形态纯规则 |
| `features/statistics/model/commandOwner.test.ts` | 识别/材料命令的控制器 intent、幂等复用、日志解析等待、超时/取消/继续与失效发布 |
| `features/statistics/pages/DataStatistics.layout.test.tsx` | 统计页按作用域失效；独立错误边界、首屏并行、缓存复用、识别快照写入、命令状态与筛选状态生命周期 |
| `features/resource-invalidation/model/resourceInvalidation.test.ts` | 去重发布、空发布忽略、revision、注销、监听器异常隔离 |
| `features/resource-invalidation/hooks/useResourceInvalidation.test.tsx` | 作用域过滤、首挂载不补发、Activity 隐藏/恢复补发、卸载注销、最新 handler |
| `features/training/model/candidates.test.ts` | 候选旧载荷、`all` 补齐、计数来源与 `all=0` 保留、引用稳定 |
| `features/training/model/queries.test.ts` | `candidates`/`counts` key、signal、失败信封、补齐读取与结构共享 |
| `features/training/pages/OperatorTraining.test.tsx` | 目录/识别失效刷新候选与计数；队列失效只重读队列；列表失败清空/计数保旧；筛选迟到响应与 Activity 恢复 |
| `features/dashboard/pages/Dashboard.test.tsx` | `dashboard-snapshot` 失效触发五路完整刷新；单路失败保留旧快照 |
| `features/statistics/api/index.test.ts`、`features/training/api/index.test.ts` | 掉落/关卡、识别解析与材料刷新的端点、signal 与载荷校验 |

针对性命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client exec vitest run \
  src/features/game-data \
  src/features/resource-invalidation \
  src/features/statistics/model \
  src/features/training/model \
  src/features/statistics/api/index.test.ts \
  src/features/training/api/index.test.ts \
  src/features/statistics/pages/DataStatistics.layout.test.tsx \
  src/features/statistics/components/DropRecords.test.tsx \
  src/features/training/pages/OperatorTraining.test.tsx \
  src/features/dashboard/pages/Dashboard.test.tsx
```

完整 `pnpm --filter la-pluma-next-client verify` 与视觉比对由任务完成记录给出。

## 关联

- [资源请求错误与取消契约](resource-requests.md)：signal、失败分类与载荷校验。
- [Query 缓存与键规范](query-cache.md)：key 规范、默认策略与迁移入口。
- [配置同步与资源一致性契约](config-sync-and-invalidation.md)：跨页失效关系与 Dashboard 完整快照。
- [前端职责与质量基线](frontend-baseline.md)：页面职责与 Activity 生命周期。
