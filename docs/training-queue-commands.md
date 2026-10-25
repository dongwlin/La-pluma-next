# 养成队列命令与写后刷新

> [← 返回文档索引](README.md)

本文描述 FPR-021 交付的养成队列领域命令。它回答：队列的增删、排序和撤销由谁写入；并发点击如何排序；写入成功后如何取得权威队列；刷新失败时页面显示什么；以及队列变化如何使材料派生进度、旧计划与总览保持一致。

相关契约：[Query 缓存与键规范](query-cache.md)、[共享资源归属与失效端口](resource-ownership.md)、[配置同步与资源一致性契约](config-sync-and-invalidation.md)、[资源请求错误与取消契约](resource-requests.md)、[前端职责与质量基线](frontend-baseline.md)。

## 1. 定位与边界

| 内容 | 唯一归属 | 说明 |
| --- | --- | --- |
| 养成队列快照 | `features/training/model/queries.ts` 的 `trainingQueueQueryOptions` | `['training', 'queue']` 是队列唯一的可写真相；页面与后续消费者只读取 |
| 队列增删、排序、撤销 | `features/training/model/queueCommands.ts` | 非 React 命令所有者；串行执行、写后刷新、fallback 与失效发布都在此 |
| 页面 pending 标记与命令发起 | `features/training/hooks/useTrainingQueueCommands.ts` | 薄适配层，把应用级 QueryClient 注入命令上下文 |
| 训练设置 | `features/training/model/settingsCommands.ts` | FPR-022 起设置提交、本地 revision 与旧响应裁决由领域所有者持有；队列命令不写设置。见[养成设置提交与计划有效期](training-settings-and-plan-validity.md) |
| 训练计划 | 页面状态 | 版本前提已由 FPR-022 接入（队列 revision + 设置 revision）；生成/应用编排仍由页面持有，FPR-023 迁移 |
| 跨域失效发布 | `features/resource-invalidation` | 命令写入成功后发布；失败不发布 |
| 总览快照 | `features/dashboard` 的完整快照协调器 | 收到 `dashboard-snapshot` 后强制刷新，不复制队列缓存 |

约束：

- **不在页面和 Query 中各存一份可写队列。** 页面从 `queueQuery.data.queue` 派生列表；写入只能经领域命令。
- **命令不是 Query mutation。** 增删、排序与撤销不走 Query 的自动重试，也不使用乐观写入覆盖服务端；它们显式串行、显式刷新。
- **写成功与刷新成功分开。** 服务端已保存但本地无法重新读取时，不回滚写入，也不把结果伪装成最新；页面显示带 `uncertain` 标记的 fallback。
- **命令寿命不跟随页面。** Activity 隐藏或页面重挂载都不会重建串行链或取消已发出的写入。

## 2. 命令与完成条件

| 命令 | 端点 | 写入后刷新 | 刷新失败 fallback |
| --- | --- | --- | --- |
| `add` | `POST /agent/training/queue` | 重新 `GET /agent/training/queue` | 在最新缓存末尾补入本地构造的队列项 |
| `remove` | `DELETE /agent/training/queue/:operatorId` | 同上 | 从最新缓存移除该干员；保留 `{ item, index }` 供撤销 toast |
| `undo` | `POST /agent/training/queue`（带 `position`） | 同上 | 在最新缓存的原索引（按当前长度夹紧）插回被移除项 |
| `reorder` | `PUT /agent/training/queue/order` | 同上 | 在最新缓存上把该干员移动到目标索引 |

完成条件：

1. 写入响应的 `success === true`；
2. 随后的队列读取成功，并用该权威快照覆盖 `training/queue`；
3. 只有 1、2 都成立才是 `applied`。

只有 1 成立、2 失败时是 `uncertain`；1 失败时是 `failed`，缓存和页面保持原样；重复命令被合并或目标已达成时是 `ignored`。`ignored` 不产生提示或错误。

## 3. 串行、重复合并与版本裁决

命令所有者维护一条模块级 Promise 串行链：

```
add / remove / undo / reorder → 排队 → 前一条写入并刷新完成 → 下一条读取最新快照 → 计算并写入
```

规则：

1. **执行时读取最新快照。** 命令参数只表达意图（操作哪个干员、目标索引、撤销哪一项），排序 payload 在真正执行时由最新队列生成，不在点击时冻结旧顺序。前一条命令的移除/排序会进入后一条命令的输入。
2. **重复添加/移除/撤销被合并，排序不合并。** 同一干员的 pending `add` / `remove` / `undo` 只保留一个请求；`reorder` 总是排队执行，并在执行时按最新位置判断是否仍需写入，因此同一干员的后续排序目标不会被丢弃。
3. **无快照时不做乐观写入。** 命令在写入前与写入后各取消一次在途的队列读取（`cancelQueries`，读取函数必须传 `AbortSignal`），避免“读取开始于写入之前、却在写入之后提交”的旧快照覆盖新结果；写入失败且此前没有快照时页面重新发起首屏读取。
4. **版本裁决在读取侧。** 队列快照携带服务端 `revision`（成员与精英目标）与 `lastUpdated`；页面比较读取到的 revision，变化时作废旧计划。`revision` 不包含设置，设置的版本由 FPR-022 的设置所有者另外维护（见[养成设置提交与计划有效期](training-settings-and-plan-validity.md)）。命令不发送条件写请求，跨客户端同时写入仍由服务端串行化，前端只保证本客户端的写入不互相覆盖。
5. **排序目标失效时明确失败。** 目标干员已不在最新队列时返回“队列已变化，请重新排序”，不发送可能回退他人更新的全量顺序。

## 4. 写后刷新与不确定状态

```
写入成功
  ├─ 重新读取队列成功 → 提交权威快照 → applied → 发布失效
  └─ 重新读取队列失败 → 在最新缓存上应用命令效果 → 标记 uncertain → 发布失效
```

- fallback 以**命令完成时**缓存中的最新队列为基准，而不是点击时的副本；期间到达的外部刷新不会被丢弃。
- fallback 快照保留 `settings`、`revision`（优先取写入响应中的 `queueRevision`）与 `flowSync`（优先取写入响应），并写入 `uncertain` 文案。
- `uncertain` 是快照字段而不是独立页面状态：下一次权威读取返回的快照不带该字段，状态自然清除；Query 的默认结构共享会因字段差异替换为权威数据。
- 页面在 `uncertain` 或“有数据但重取失败”时显示警告条与“重新加载”，并禁用计划预览/应用；重新加载成功后警告消失。
- 写入成功但刷新失败仍然发布失效：服务端已经变化，其他页面应刷新；本页不再为自己的发布做第二次重读。

## 5. 失效联动

队列写入确认成功后发布一次：

| 作用域 | 原因 |
| --- | --- |
| `training-queue` | 队列成员、顺序、材料进度与服务端 revision 已变化 |
| `materials` | 队列项的派生材料进度变化 |
| `training-plan` | 已生成计划的队列前提变化 |
| `dashboard-snapshot` | 总览快照包含队列与材料摘要 |

发布参数为 `cause: 'training-queue'`，并携带 `detail: { source: 'training-queue-command' }`：

- `OperatorTraining` 忽略带该 `detail` 的发布，因为权威快照已写入同一 Query key；外部发布的 `training-queue`（不带该标记）仍会触发重读。
- `Dashboard` 只订阅 `dashboard-snapshot`，收到后走完整快照刷新；五路读取全部有效才提交，单路失败保留旧快照。
- 候选列表与状态计数不因队列写入而失效；材料刷新/识别命令仍按 `materials` / `operbox` / `depot` 作用域触发候选与计数重取。
- 计划失效路径：命令开始时立即作废旧预览（即使用户随后取消或失败，见既有回归），读取到 revision 变化时作废，以及设置版本变化时作废（FPR-022）。前者保证“点击排序后旧计划按钮立即不可应用”，后两条覆盖识别、材料刷新、外部设置修改和另一客户端造成的队列变化。

## 6. 页面与生命周期

- `OperatorTraining` 用 `useQuery(trainingQueueQueryOptions())` 读取队列，用 `useTrainingQueueCommands()` 发起命令并派生 `pendingOperatorIds` / `queueMutationPending`。
- 队列命令所有者为模块级单例；Activity 隐藏只注销页面 Effect，不中断串行链与写后刷新。隐藏期间完成的命令仍会写入应用级 Query 缓存，恢复时按新鲜度使用。
- 真正卸载后重挂载：命令继续完成（请求没有 AbortController 绑定页面），新页面从 Query 缓存读取结果；pending 提示是否仍显示取决于命令是否完成，不再由旧页面闭包维护。
- 页面首屏：首次成功的队列快照把 `flowSync` 同步到页面状态，并把 `settings` 交给 FPR-022 的设置所有者 hydrate；若用户先编辑设置，则不采用迟到的首屏值。普通队列刷新不覆盖本地设置，`reloadQueue()` 在读取期间本地设置未变化时采用服务端值（外部设置变化由此被发现）。
- 生成计划前、应用失败后、重试同步后与显式“重新加载”都通过 `reloadQueue()` 强制重取；`reloadQueue` 比较快照 revision 与设置版本，作废过期预览。
- `recordSync` 在 `flowSync.status === 'synced'` 时继续派发 `training-plan-applied` window 事件，供 automation 兼容；FPR-023 将替换为领域失效协议。

## 7. 兼容与回滚

- 端点、请求体、响应体、服务端存储与 `flowSync` / `revision` 形状均未改变；`getTrainingQueue`、`addToTrainingQueue`、`removeFromTrainingQueue`、`updateTrainingQueueOrder` 的位置参数与 `ApiResponse` 信封保持兼容。
- 新增 `['training', 'queue']` Query key；回滚到页面本地队列时不需要服务端迁移，缓存按 `gcTime` 自然淘汰。
- 新增的 `uncertain` 字段只存在于前端 Query 缓存，不写入服务端，也不进入任何持久化存储。
- `detail.source` 是本任务声明的可选字段；不了解该字段的订阅者按普通 `training-queue` 发布处理，行为安全。
- 独立回滚范围：页面与 `hooks/useTrainingQueueCommands.ts`、`model/queueCommands.ts`、`model/queries.ts` 的队列定义；不要求删除已有端点能力。

## 8. 回归证据

| 文件 | 覆盖 |
| --- | --- |
| `features/training/model/queueCommands.test.ts` | 并发排序按最新快照串行、重复添加合并、写后刷新失败 fallback/`uncertain`、写入失败不提交不发布、移除后撤销按原索引恢复、目标干员消失时拒绝排序、写前取消读取 |
| `features/training/model/queries.test.ts` | `queue` key、signal、快照元数据与失败信封 |
| `features/training/pages/OperatorTraining.test.tsx` | 队列读取迁移后原有交互；移除进行中排队排序、写后刷新失败的 fallback/警告/重载、跨页失效作用域与自发布忽略、计划 revision 失效、Activity 隐藏恢复 |
| `features/training/model/settingsCommands.test.ts`、`planValidity.test.ts` | 设置串行写入、旧响应裁决与计划版本前提（FPR-022，见[养成设置提交与计划有效期](training-settings-and-plan-validity.md)） |
| `features/dashboard/pages/Dashboard.test.tsx` | `dashboard-snapshot` 接收端完整刷新与单路失败保旧 |
| `features/resource-invalidation/**` | 失效端口去重、revision、Activity 恢复补发 |

针对性命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client exec vitest run \
  src/features/training/model/queueCommands.test.ts \
  src/features/training/model/queries.test.ts \
  src/features/training/pages/OperatorTraining.test.tsx \
  src/features/dashboard/pages/Dashboard.test.tsx \
  src/features/resource-invalidation
```

完整 `pnpm --filter la-pluma-next-client verify` 与 72 张视觉比对由任务完成记录给出。

## 关联

- [Query 缓存与键规范](query-cache.md)：队列 key、默认策略与写后失效规则。
- [养成设置提交与计划有效期](training-settings-and-plan-validity.md)：设置所有权、设置 revision 与计划前提。
- [共享资源归属与失效端口](resource-ownership.md)：队列归属与触发映射。
- [配置同步与资源一致性契约](config-sync-and-invalidation.md)：跨页失效关系、计划有效期与 Dashboard 快照。
- [前端职责与质量基线](frontend-baseline.md)：Activity 生命周期与页面职责。
