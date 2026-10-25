# 配置持久化协调器

> [← 返回文档索引](README.md)

本文描述 `client/src/features/user-config/` 的持久化协调模型、域适配契约与薄 hooks。它是[配置同步与资源一致性契约](config-sync-and-invalidation.md)中“三页各自加载/保存”的迁移目标：协调器与竞态回归已在 FPR-012 交付，三个域接入由后续配置迁移任务完成（FPR-013 肉鸽、FPR-014 作业、FPR-015 自动化）。接入完成前页面仍使用第 6 节列出的现有实现，本文的目标契约不能当成当前行为。

验证入口见文末[回归证据](#7-回归证据)。

## 1. 定位与边界

协调器是应用级非 React 对象，按配置 key 提供唯一通道。页面可以卸载、`Activity` 可以隐藏，但已接受的草稿与已入队的提交不属于某个页面实例。

| 能力 | 归属 | 不负责 |
| --- | --- | --- |
| 草稿与服务端 wire 编解码、旧格式迁移、本地草稿布局 | 域适配器 | 判断何时提交、是否已被新编辑取代 |
| revision/token、pending 标记、串行提交队列、去抖、重试、加载次序 | 协调器 | 字段语义、端点选择、完整提交条件 |
| 完整提交（配置 + schedule 等域内步骤） | 适配器 `commit` | 跨请求事务、服务端回滚 |
| 渲染、失败提示、成功 toast | 页面 | 再维护一份 pending/revision 状态 |

协调器不把 `saveUserConfig` 成功等同于完整持久化成功：一次提交要写哪些端点、什么条件下才算完成，全部由适配器决定；只有 `commit` 返回 `{ ok: true }` 才清除 pending。

## 2. 协调模型

### 2.1 通道与生命周期

`UserConfigCoordinator.channel(adapter)` 按 `adapter.key` 返回稳定通道。同一 key 重复注册只替换适配器实现，**不重置**草稿、revision、定时器或队列，因此：

- 页面真实卸载后重挂载不会重建提交队列，旧请求与新提交仍按入队顺序执行；
- 已加载的通道重挂载时 `hydrate()` 返回 `skipped`，不会重新读取服务端；需要重新读取时显式 `reload({ force: true })`；
- 适配器必须同构：同一 key 的 `pendingKey`、wire 语义与完整提交条件一致。`pendingKey` 不一致会抛出契约错误，避免两份草稿协议共存。

### 2.2 revision、token 与 pending 标记

每次 `setDraft` 接受一份与当前 wire 内容不同的草稿时：

1. `revision` 递增；
2. 生成新的同步 token，写入适配器的 `pendingKey`；
3. 写入本地草稿；
4. 按适配器策略安排提交（见 2.3）。

提交前后都重新校验「revision 未变 + 内存 token 未变 + 存储中的标记仍是该 token」。因此：

- 旧提交即使成功，也不能清除新草稿的标记或把新草稿标成已同步；
- 旧提交失败不会覆盖新草稿的成功结果，也不会把错误写进新 revision；
- 其他写入者替换了标记时，本次提交不会确认任何草稿。

wire 内容未变的 `setDraft` 会被跳过（默认对 `encodeDraft` 结果做 JSON 比较）；页面从表单状态派生草稿时不会造成重复提交。

### 2.3 提交策略

`commitDelayMs` 是唯一的时机参数：

- `0`：每次编辑立即入队（automation 的事件触发策略）；
- 大于 `0`：去抖，只提交最后一次编辑（combat/roguelike 的 300ms 策略）。

无论哪种策略，同一 key 的提交都在一条 Promise 队列中串行。连续编辑时，队列中迟到的旧快照在发起请求前即被丢弃，只有最新 revision 会真正写入。

### 2.4 状态

| 字段 | 含义 |
| --- | --- |
| `draft` | 最近接受或加载的草稿；首次加载完成前为 `null` |
| `hydrated` | 是否已有可用草稿。读取彻底失败时为 `false`，下次 `hydrate` 会重试 |
| `pending` | 本设备存在尚未被完整提交确认的草稿 |
| `syncState` | `idle` / `queued`（等待去抖或队列）/ `saving`（正在提交）/ `failed`（当前草稿未完整持久化） |
| `error` | 最近一次同步失败的可展示原因；完整提交成功后清空 |
| `revision` | 每次接受新草稿递增 |
| `lastSavedAt` | 最近一次完整提交成功的时间戳 |

```
setDraft ─→ queued ─→ saving ─→ idle
                  └──────────→ failed ──commitNow()──→ saving ─→ …
恢复未同步草稿 ─────────────────────→ failed（pending=true）
reload() ─→ loaded / local-draft / skipped / stale / failed
```

## 3. 适配契约

```ts
export interface ConfigPersistenceAdapter<TDraft, TWire = unknown> {
  readonly key: string
  readonly pendingKey: string
  readonly commitDelayMs?: number
  readonly restoredMessage?: string
  readonly formatFailure?: (message: string) => string
  encodeDraft(draft: TDraft): TWire
  decodeDraft(payload: unknown): TDraft | null
  readLocalDraft(): TDraft | null
  writeLocalDraft(draft: TDraft): void
  commit(wire: TWire): Promise<ConfigCommitResult>
  fetch(options: { signal: AbortSignal }): Promise<ConfigLoadResult>
  fingerprint?(draft: TDraft): string
}
```

| 成员 | 要求 |
| --- | --- |
| `key` / `pendingKey` | 沿用服务端 key 与既有本地标记键；同一 key 的适配器必须同构 |
| `encodeDraft` | 只输出持久化需要的字段；界面字段（图标、参数表单）不得进入 wire，否则指纹与提交通道都被污染 |
| `decodeDraft` | 同时承担旧值迁移与形状校验；返回 `null` 表示载荷不可用，协调器回退本地草稿。字段级合并与默认值策略属于适配器 |
| `readLocalDraft` | 缺失或损坏时返回 `null` 并清理损坏键，不要抛出；存在 pending 标记但返回 `null` 时，协调器删除标记并继续读服务端 |
| `writeLocalDraft` | 与读取对称；服务端加载成功、接受编辑、加载本地回退时都会被调用 |
| `commit` | **完整提交**：所有域内写入全部成功才返回 `ok`。返回 `{ ok: false, message }` 或抛出都会保留 pending 与重试入口 |
| `fetch` | 应响应 `signal` 中止；结果只提供载荷，形状校验交给 `decodeDraft` |
| `fingerprint` | 可选；默认对 wire 做 JSON 序列化。用于跳过内容等价的编辑 |
| `restoredMessage` / `formatFailure` | 可选文案钩子；默认文案见 `DEFAULT_RESTORED_MESSAGE` 与 `model/configCoordinator.ts` |

完整提交的典型形态（以 automation 为例，真实实现由 FPR-015 交付）：

```ts
async commit(wire) {
  const saved = await saveUserConfig('automation-tasks', {
    taskFlow: wire.taskFlow,
    schedule: { enabled: wire.schedule.enabled, times: wire.schedule.times },
  })
  if (!saved.success) return { ok: false, message: getErrorMessage(saved) }

  const schedule = wire.schedule.enabled && wire.schedule.times.length > 0
    ? await setupSchedule('default', wire.schedule.times, wire.taskFlow)
    : await stopSchedule('default')
  return schedule.success ? { ok: true } : { ok: false, message: getErrorMessage(schedule) }
}
```

配置已保存而 schedule 失败时返回 `ok: false`，协调器保留 pending；重试重新执行整段 `commit`。这不声称跨请求已获得事务原子性，只保证不会把半完成的写入当作已同步。

## 4. 薄 hooks

```tsx
import { useUserConfig, type ConfigPersistenceAdapter } from '@/features/user-config'

const adapter: ConfigPersistenceAdapter<CombatDraft, CombatWire> = { /* 域内常量，见第 6 节 */ }

function CombatTasks() {
  const { draft, hydrated, pending, syncState, error, update, retry, reload } = useUserConfig(adapter)
  // draft 渲染表单；update 接受编辑；retry 绑定“重新同步”；reload({ force: true }) 用于外部写入后强制重读
}
```

| 返回 | 说明 |
| --- | --- |
| `draft` / `hydrated` / `pending` / `syncState` / `error` / `revision` / `lastSavedAt` | 协调器状态；`useSyncExternalStore` 订阅，状态对象只在变化时替换 |
| `update(draft)` | 等价于通道 `setDraft`：写本地、刷新 revision/token、按策略提交 |
| `retry()` | 立即提交当前草稿并等待**本次**尝试；返回当前 revision 是否已确认 |
| `reload({ force })` | 重新读取；`force` 绕过已加载守卫 |
| `channel` | 非渲染场景（事件监听、卸载前刷新）直接访问通道 |

`autoHydrate: false` 时 hook 不自动加载，由调用方在合适的时机调用 `reload()`。hook 不在卸载时取消队列，也不写任何全局状态。

## 5. 加载、刷新与外部写入

`reload()` 的优先级与结果：

| 场景 | 行为 | 结果 |
| --- | --- | --- |
| 本设备有 pending 标记且草稿可读 | 直接采用本地草稿，不请求服务端 | `local-draft` |
| pending 标记但没有可读草稿 | 删除标记，继续读服务端 | 视服务端结果 |
| 已加载且未强制 | 不做任何请求 | `skipped` |
| 服务端载荷可用 | 采用服务端草稿、迁移并回写本地 | `loaded` |
| 服务端失败或载荷不可用 | 回退本地草稿；都没有则不标记已加载 | `loaded`（本地）/ `failed` |
| 加载期间出现新编辑或新加载 | 丢弃本次响应 | `stale` |

关键约束：

- **未确认草稿优先**：`force` 也不覆盖它。外部写入（如养成计划应用）遇到 `local-draft` 或 `pending` 时应拒绝或合并冲突，而不是清掉本地编辑；该裁决由 FPR-015 在 automation 适配器中实现，协调器只提供明确的结果与状态。
- **迟到加载不写回**：加载返回时校验加载序号、`AbortSignal`、revision 与 pending 标记；任何一项变化都返回 `stale`。
- **损坏草稿可回退**：单个损坏键由适配器清理；标记指向的草稿整体不可读时删除标记并读服务端，不会永久停在“本地优先”。
- **读取失败会重试**：`failed` 不标记 `hydrated`，`Activity` 恢复或下次挂载会再次尝试；服务端失败且本地有草稿时静默回退，不打断编辑。

## 6. 三域适配边界

协调器交付时页面尚未接入，以下清单是后续迁移必须保留的语义。接入任务只替换页面内的加载/保存/重试接线，不改变 key、本地格式或视觉。

| 项目 | Combat | Roguelike | Automation |
| --- | --- | --- | --- |
| 配置 key | `combat-tasks` | `roguelike-tasks` | `automation-tasks` |
| 本地草稿 | `combatTaskInputs`、`combatAdvancedParams`、`combatAutoFormation`、`combatCopilotSetExecutionMode`、`combatCopilotSetSelections` | `roguelikeTaskInputs`、`roguelikeAdvancedParams` | `maa-task-flow`、`maa-schedule` |
| pending 键 | `combatConfigSyncPending` | `roguelikeConfigSyncPending` | `automationConfigSyncPending` |
| 提交时机 | 300ms 去抖 | 300ms 去抖 | 编辑即入队（事件触发） |
| 加载迁移 | `app`→`cli`；raid `1`/`2`→`raid`/`both` | 无 | `times`→`entries` 兼容；禁用项只留在本地 |
| 完整提交 | `saveUserConfig` | `saveUserConfig` | `saveUserConfig` + `setupSchedule`/`stopSchedule` |
| 迁移任务 | FPR-014 | FPR-013 | FPR-015 |

接入时的额外边界：

- 页面不再自己维护 `configRevisionRef`、模块级 Promise 队列、`configHydratedRef` 或 `isRetryingConfigSave`；这些职责已由通道承担。
- `Activity` 隐藏/恢复只影响 Effects；`hydrate()` 的已加载守卫保证恢复时不重读，pending 草稿仍优先。
- automation 的 `training-plan-applied` 需通过 `reload({ force: true })` 重读；返回 `local-draft` 时不得丢弃本地编辑。
- 状态消息（成功 toast）与页内错误文案由页面从 `syncState`/`error` 和 `retry()` 结果派生，协调器不直接写 `statusStore`。

## 7. 回归证据

| 测试 | 覆盖 |
| --- | --- |
| `features/user-config/model/configCoordinator.test.ts` | 非 React：服务端加载与迁移、未同步草稿优先、损坏草稿回退、迟到加载丢弃、强制刷新中止旧加载、提交串行与旧提交不确认新草稿、标记被外部替换、去抖合并、内容等价跳过、完整提交失败与重试防重入、编辑中断重试、跨重挂载队列与状态、异构适配器拒绝 |
| `features/user-config/hooks/useUserConfig.test.tsx` | 首次加载与订阅渲染、编辑写回、`autoHydrate: false`、失败提示与重试后清空 |

复现命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client verify
```

本任务未修改页面、配置 key、本地存储格式或视觉基线，因此不需要更新截图；三域接线后的页面/视觉回归由各自迁移任务执行。

## 关联

- [配置同步与资源一致性契约](config-sync-and-invalidation.md)：三页现行行为、缺口与跨页失效关系。
- [前端职责与质量基线](frontend-baseline.md)：八页职责矩阵与生命周期。
- [开发文档](development.md)：测试治理与常用检查。
