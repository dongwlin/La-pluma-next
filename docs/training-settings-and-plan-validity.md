# 养成设置提交与计划有效期

> [← 返回文档索引](README.md)

本文描述 FPR-022 交付的养成设置所有者与计划有效期模型。它回答：设置由谁提交、连续编辑如何排序；旧响应能否覆盖新值；计划在什么条件下仍然可应用；队列或设置变化、队列刷新失败时页面如何阻止使用过期计划。

相关契约：[养成队列命令与写后刷新](training-queue-commands.md)、[Query 缓存与键规范](query-cache.md)、[配置同步与资源一致性契约](config-sync-and-invalidation.md)、[前端职责与质量基线](frontend-baseline.md)。

## 1. 定位与边界

| 内容 | 唯一归属 | 说明 |
| --- | --- | --- |
| 设置值、已确认值、本地 revision、串行写链 | `features/training/model/settingsCommands.ts` 的 `TrainingSettingsOwner` | 非 React 所有者；页面卸载与 Activity 隐藏不重建 |
| 设置所有权状态订阅与编辑入口 | `features/training/hooks/useTrainingSettings.ts` | 薄适配层，不含请求或竞态逻辑 |
| 计划版本前提与可用性判断 | `features/training/model/planValidity.ts` | 纯函数：basis 捕获、版本比较、生成/应用可用性 |
| 计划生成/应用编排 | `features/training/pages/OperatorTraining.tsx` | FPR-022 只把版本前提接入现有编排；整体迁移由 FPR-023 负责 |
| 队列快照与队列写入 | `features/training/model/queries.ts`、`queueCommands.ts` | 队列 revision 由服务端提供；设置不进入队列写命令 |

约束：

- **设置只有一份可写真相。** 页面不再持有 `settings` 独立 state、request id 或写队列；显示值与提交值都来自所有者。
- **提交在模块级串行。** 同一时刻只有一次 `PUT /agent/training/settings` 在途；后续编辑排在它之后，执行时提交自己的完整设置对象。
- **只有最新编辑的响应能改变页面值。** 旧响应成功只更新内部 `persisted`，供后续失败回滚；旧响应失败不会回滚新草稿，也不产生提示。
- **计划前提是版本而不是快照副本。** 页面不保存生成时的队列/设置副本，只保存 `{ queueRevision, settingsRevision }`；前提变化即作废旧计划。

## 2. 设置版本与提交模型

服务端没有独立的设置 revision：`PUT /agent/training/settings` 返回归一化后的设置，`GET /agent/training/queue` 的 `revision` 只覆盖队列成员与精英目标。因此设置版本由客户端所有者维护：

| 事件 | 页面值 | `persisted` | `revision` |
| --- | --- | --- | --- |
| 一次内容不同的编辑 | 立即变为新值 | 不变 | +1 |
| 最新写入成功 | 采用响应中的归一化值 | 更新 | 值变化时 +1 |
| 旧写入成功 | 不变 | 更新 | 不变 |
| 最新写入失败 | 回滚到 `persisted` | 不变 | 值变化时 +1 |
| 旧写入失败 | 不变 | 不变 | 不变 |
| 首次成功快照 hydrate | 采用服务端值 | 更新 | 值变化时 +1 |
| 显式重新加载采用服务端值 | 采用服务端值 | 更新 | 值变化时 +1 |

`revision` 只表示可观察设置值变化，不表示请求次数；内容相同的编辑返回 `ignored`，不写请求、不递增。

每次写入确认成功都发布一次 `{ resources: ['training-plan'], cause: 'training-settings', detail: { source: 'training-settings-owner' } }`；失败不发布。本页的旧计划已由编辑与 revision 立即作废，该发布供同一应用内的其他订阅者使用；本页忽略带该 `detail` 的发布，避免清空用户在写入期间重新生成的预览。

写入失败时页面显示“设置保存失败，已恢复原设置”，不把失败静默成已保存。网络失败无法区分“服务端未写入”和“已写入但响应丢失”：当前先按未写入回滚，下一次权威队列读取若返回不同设置会采用服务端值并使计划失效。

## 3. 加载、外部变化与生命周期

- **首次 hydrate**：首个成功队列快照到来时采用其中的 `settings`。若用户已经编辑过（无论写入是否完成），不再采用迟到的首屏值。
- **普通刷新不覆盖本地设置**：队列命令的写后快照、候选/材料失效等只更新队列与计数，不改变设置显示值。
- **权威重读可发现外部设置变化**：`reloadQueue()` 在读取完成时，若读取期间本地设置既没有在途写入、也没有 revision 变化，则采用服务端 `settings`。因此“重新加载”、生成计划前的强制读取、外部 `training-queue` 失效都能发现另一客户端的设置修改，并使旧计划失效。
- **Activity 与卸载**：所有者为模块级单例；隐藏/恢复只影响订阅，不影响写链。页面真正卸载后重挂载仍读取同一设置值与 `persisted`，旧提交先于新提交执行。
- **失败重试**：没有单独的设置重试按钮；用户再次切换即产生下一份完整提交。失败的 `syncState` 与错误原因保留到下一次成功写入或采用不同的服务端值。

限制：队列 `revision` 不包含设置，因此设置单独变化不会通过 revision 被其他客户端感知；本客户端需要一次队列重读（刷新、生成前读取或显式重新加载）才能采用外部值。跨客户端同时写入仍是最后写入生效，客户端只保证本客户端的写链不互相覆盖。

## 4. 计划有效期

一次预览在生成时冻结：

```ts
interface TrainingPlanBasis {
  queueRevision: string | null      // 生成前权威队列快照的服务端 revision
  settingsRevision: number          // 生成前的设置版本
}
```

以下任一情况使 basis 失效：

- 队列 revision 变化：本页增删/排序/撤销（命令开始时立即作废）、识别/材料刷新、另一客户端造成的成员或精英目标变化；
- 设置 revision 变化：编辑、写入归一化、失败回滚、权威重读采用外部设置；
- 计划范围切换、应用失败、同步重试发现新 revision 等既有路径仍直接清空预览。

作废同时清空计划与计划错误，页面回到“队列变更后需重新预览”的占位；不会保留一个仍显示“可应用”的旧计划。

### 4.1 生成

```
检查：有队列、非 busy、队列刷新未失败
  → reloadQueue() 强制读取权威队列（失败则报错，不生成）
  → 冻结 basis = { freshQueue.revision, 当前 settings revision }
  → POST /agent/training/plan
  → 响应 queueRevision 与 freshQueue.revision 不符：刷新队列并提示重新预览
  → 通过：提交 plan + basis
```

刷新失败（包括不确定 fallback 与“有旧快照但重取失败”）时预览按钮禁用，`handleGeneratePlan` 也再次拒绝，避免用旧快照生成计划。

### 4.2 应用

应用按钮只在 `plan` 存在、`basis` 与当前队列/设置版本一致、非 busy 且队列刷新未失败时可用。点击时重新读取所有者最新设置并二次校验版本，然后提交：

```ts
applyTrainingPlan({ plan: getOpenStagePlan(plan), settings: 所有者当前 settings })
```

显式“重新加载”会先作废旧预览；恢复后用户需要重新预览。应用成功后保留预览，应用失败则清空计划并重读队列。

## 5. 页面接线

- 设置开关调用 `handleUpdateSettings`：先立即作废旧计划，再 `updateSettings`；失败且未被后续编辑取代时显示全局错误。
- 队列快照 effect 只做首次 `hydrate` 与 `flowSync` 同步；`reloadQueue()` 负责受控采用服务端设置。
- 队列 revision effect 与设置 revision effect 都调用同一 `invalidatePlan()`。
- 失效订阅忽略设置所有者自己的 `training-plan` 发布（`detail.source = 'training-settings-owner'`）；外部 `training-plan` 发布仍作废旧计划。
- 渲染层用 `plan && basisCurrent` 决定是否展示计划详情与“应用到…”按钮，避免 effect 清除前的空窗期仍显示可应用旧计划。

## 6. 兼容与回滚

- 端点、请求体、响应体与服务端存储未改变；设置仍写入训练队列文件中的 `settings` 字段，`PUT /agent/training/settings` 的返回形状不变。
- 未新增 localStorage、Query key 或持久化版本；设置 revision 只存在于模块内存，刷新页面随计划一起丢失。
- 页面结构、DOM 与 CSS 未改变；按钮的可用/禁用状态由版本前提决定。
- 新增的 `training-settings` 失效发布只使用既有 `training-plan` 作用域与可选 `detail.source`；不了解该 cause/detail 的订阅者按普通 `training-plan` 事件处理，行为安全。它不跨浏览器标签页，也不替代服务端 revision。
- 独立回滚范围：`model/settingsCommands.ts`、`model/planValidity.ts`、`hooks/useTrainingSettings.ts` 与 `OperatorTraining` 的设置/计划接线；回滚后恢复页面本地设置 state，不需要服务端迁移。

## 7. 回归证据

| 文件 | 覆盖 |
| --- | --- |
| `features/training/model/settingsCommands.test.ts` | 默认值；串行编辑与旧响应不覆盖新值；旧失败不打断新草稿；最新失败回滚；服务端归一化；缺省响应回退；等值编辑忽略；首次 hydrate 只采用一次；编辑后拒绝迟到快照；写入期间忽略快照、之后采用显式重载；reset 丢弃迟到写入；成功才发布 `training-plan`；失败原因兜底 |
| `features/training/model/planValidity.test.ts` | basis 捕获与空 revision；队列/设置版本任一不符即失效；刷新失败、busy、无队列时禁止生成；版本失效、刷新失败、无计划时禁止应用 |
| `features/training/pages/OperatorTraining.test.tsx` | 设置串行写入与旧响应；设置跨页面重挂载串行；设置失败回滚与重试；设置变化作废旧计划并按新设置重新预览/应用；写入期间生成的预览不被自身发布清空；权威重读采用外部设置并作废旧计划；队列刷新失败时禁用生成/应用、重载后重新预览恢复；目录失败清空候选并保留计数；仅计数失败时列表保留、计数保旧 |

针对性命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client exec vitest run \
  src/features/training/model/settingsCommands.test.ts \
  src/features/training/model/planValidity.test.ts \
  src/features/training/pages/OperatorTraining.test.tsx
```

完整 `pnpm --filter la-pluma-next-client verify` 与 72 张视觉比对由任务完成记录给出；本文件不声称未执行的验证。

## 关联

- [养成队列命令与写后刷新](training-queue-commands.md)：队列唯一可写真相、串行命令、revision 与不确定 fallback。
- [Query 缓存与键规范](query-cache.md)：队列/候选/计数缓存与失效规则。
- [配置同步与资源一致性契约](config-sync-and-invalidation.md)：跨页失效关系与计划有效期缺口。
- [前端职责与质量基线](frontend-baseline.md)：活动生命周期与页面职责。
