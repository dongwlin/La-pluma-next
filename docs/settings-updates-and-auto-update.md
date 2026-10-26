# 设置组件更新与自动更新

> [← 返回文档索引](README.md)

本文描述 FPR-026 交付的设置页组件更新与自动更新边界：core 更新/渠道切换、CLI 更新、资源热更新四条命令，自动更新策略的读取/草稿/完整提交，以及更新成功后的版本失效与跨域资源失效。版本资源的 Query 身份见[设置设备连接与系统资源](settings-device-and-resources.md)，配置编辑见[设置配置编辑与保存](settings-config-editing.md)，失效端口见[共享资源归属与失效端口](resource-ownership.md)。

## 1. 定位与边界

| 能力 | 唯一所有者 | 形态 | 不负责 |
| --- | --- | --- | --- |
| core 更新 / 渠道切换 / CLI 更新 / 资源热更新 | `features/settings/model/updateCommands.ts` 的 `SettingsUpdateOwner` | 显式 POST 命令；共用一条在途槽位；不进入 Query | 版本读取、跨域失效发布 |
| 更新后的版本同步 | `features/settings/hooks/useSettingsUpdates.ts` 调用 `useSettingsVersion().reload()` | 后者 `invalidateQueries` 同一 `settings/version` | 伪造版本快照 |
| 更新后的跨域失效 | 同一 hook | 成功确认后推进物品图标 epoch，并发布 `catalog`/`materials`/`training-plan`/`dashboard-snapshot`（`cause: resource-update`） | 清空 Query 缓存、轮询 |
| 自动更新策略草稿与完整提交 | `features/settings/model/autoUpdateConfig.ts` 的 `AutoUpdateConfigOwner` | 模块级草稿；保存 = 写 user config + 应用调度 | 定时任务本身的执行 |
| 自动更新归一化与时间校验 | `features/settings/model/configNormalization.ts` | 纯函数 | 草稿生命周期 |
| 页面反馈、按钮 loading、反馈渲染 | `components/AutoUpdateConfigPanel.tsx`、`components/ComponentUpdatePanel.tsx` | 只渲染 owner 状态 | 再维护 update/auto-update 草稿 |

四条更新命令与自动更新保存都是**写入**：没有 Query mutation、没有自动重试，也没有 AbortSignal。用户取消页面或 Activity 隐藏只停止观察，不会撤销已提交的写入。

## 2. 组件更新命令

### 2.1 互斥与生命周期

`SettingsUpdateOwner` 只有一个 `running` 槽位：

| 状态 | 含义 |
| --- | --- |
| `running: 'core'` | 普通 core 更新（不传版本，服务端 `maa update` 并同步资源） |
| `running: 'core-channel'` | 切换到 Beta/正式版（`install <channel> --force` 并同步资源） |
| `running: 'cli'` | CLI 更新 |
| `running: 'resources'` | 仅同步游戏资源 |
| `running: null` | 空闲 |

规则：

- 任意一条命令运行期间再次发起（含同一命令）返回 `status: 'ignored'`，不发第二个请求；页面据此禁用全部更新按钮，只让实际运行的按钮显示 loading。
- 开始运行时清空页内反馈（CLI 更新除外）；失败返回 `failed`，成功返回 `succeeded`。
- 命令失败不自动重发。core/资源热更新在部分失败时把 `resourceRetry` 置为 true，页面显示“重试资源同步”按钮；该按钮调用资源热更新，仍是用户显式动作。
- 寿命不跟随页面：Activity 隐藏或页面重挂载不取消在途命令；完成后仍写 owner 状态并更新全局提示。

### 2.2 失败与重试条件

| 结果 | 页内反馈 | 全局提示 | 资源重试入口 |
| --- | --- | --- | --- |
| core / 渠道切换成功 | success，`result.message` 或 `MaaCore 和资源已更新` | 同一文案 | 否 |
| core / 渠道切换失败，`errorInfo.details`（兼容旧 `error.details`）的 `failedStep === 'resources'` 或 `coreUpdated === true` | error | 服务端文案 | 是 |
| core / 渠道切换失败，其它路径 | error | 服务端文案 | 否 |
| CLI 成功 | 不产生页内反馈（保留此前的更新反馈） | `MAA CLI 更新成功` | 否 |
| CLI 失败 | 不产生页内反馈 | `更新失败: <原因>` | 否 |
| 资源热更新失败（含内层失败、网络失败） | error | 服务端/本地文案 | 是 |
| 网络异常 | error（CLI 除外） | `网络错误: <原因>` | 资源热更新为是 |

渠道切换目标由 `resolveCoreChannelSwitch(currentCore)` 决定：版本字符串包含 `beta`/`alpha` 时切到正式版，否则切到 Beta；版本尚未读取时默认 Beta。成功文案使用 `Beta`/`正式版` 标签。

## 3. 成功后的版本与资源失效

更新命令确认成功后，React 适配层执行三项副作用：

1. **物品图标缓存版本**：资源变化成功后调用 `invalidateItemIconCache()`，推进并持久化 `laPlumaItemIconVersion`；`getItemIconUrl()` 使用 `?v=<epoch>`，训练/统计页通过 `useItemIconCacheVersion()` 重新渲染，避免浏览器继续命中同一路径的旧图。CLI 更新不推进。
2. **版本失效**：调用 `useSettingsVersion().reload()`，其内部 `queryClient.invalidateQueries({ queryKey: settingsKeys.query('version') })`。页面可见时立即重取；Activity 隐藏时 Query 没有观察者，失效标记保留，恢复显示后按 `refetchOnMount` 重新读取，不会被 30s 新鲜期挡住。
3. **资源失效**：core 更新、渠道切换与资源热更新发布 `catalog`、`materials`、`training-plan`、`dashboard-snapshot`，`cause: 'resource-update'`。CLI 更新只改变 CLI 版本，不发布资源失效，也不推进图标 epoch。

完成提示（成功或失败）在命令 HTTP 返回后立即发出，资源失效与版本重取随后执行；按钮在命令返回时恢复可点，早于版本重取结束（迁移前的 loading 会覆盖到版本重取完成）。因此用户立即发起第二条命令时，其开始提示不会被第一条的成功提示覆盖。

图标 epoch 由本客户端发起的手动更新推进；服务端定时自动更新或其他客户端触发的资源变化不会主动通知本标签页，需等待浏览器缓存过期或本客户端下一次手动更新。干员头像仍是各页面直接构造的独立 URL，不在该机制内。

影响范围与[资源归属与失效端口](resource-ownership.md)第 5 节一致：

| 接收方 | 收到的作用域 | 动作 |
| --- | --- | --- |
| OperatorTraining | `catalog`/`materials` | 失效候选与计数 query；`training-plan` 作废旧计划预览 |
| DataStatistics | `catalog` | 失效干员目录读取 |
| Dashboard | `dashboard-snapshot` | 完整快照刷新，失败保留旧快照 |
| 物品图标 | 本地 icon cache epoch | `useItemIconCacheVersion()` 触发重渲染，`<img src>` 换用 `?v=<epoch>` |
| 其它资源（`depot`、`operbox`、`drops` 等） | 不发布 | 识别快照与掉落不由资源更新重写，保持缓存 |

失败与取消不发布失效，也不重取版本以外的资源。失效只标记/重取明确受影响的 key，不调用 `queryClient.clear()`，不整体清空无关缓存。

## 4. 自动更新策略

### 4.1 读取与本地回退

`AutoUpdateConfigOwner.load()`：

1. 读取服务端 `auto-update` 用户配置并归一化。成功且载荷可归一化时采用，`dirty=false`，清空此前的读取/保存反馈，并把该副本写入 `autoUpdateConfig` 本地键（编辑过的草稿不采用、不覆盖）。
2. 服务端失败时读取本设备上次保存的 `autoUpdateConfig`：可归一化时作为草稿（`dirty=true`），并给出 warning。服务端错误存在时文案为 `自动更新设置读取失败: <原因>，已显示此设备上次保存的设置，请保存后重试`；否则为 `已载入此设备上次保存的自动更新设置，请保存后应用`。
3. 本地 JSON 损坏时给出 `自动更新设置读取失败: <解析原因>`，不伪造草稿。
4. 服务端成功但载荷不可归一化时按“无服务端错误”走本地回退；没有本地草稿且无服务端错误时保持默认值、不提示。

读取守卫：`load()` 记录开始时的 revision 与 touched；读取期间出现编辑（revision 推进、touched=true）或确认保存（revision 推进）时，迟到响应不写草稿。页面每次真正挂载读取一次；Activity 隐藏/恢复不重读（hook 的初始化标记随页面 state 保留），真正重挂载会重读：未保存草稿不会被覆盖，确认保存后的读取可以重新采用服务端副本（例如其它客户端已更新）。

### 4.2 草稿与保存

任意 `update(patch)` 都：

- 合并当前草稿，`dirty=true`，清空页内反馈；
- 推进本地 revision；
- 立即把草稿写入 `autoUpdateConfig` 本地键（本设备 fallback，不代表服务端已确认）。

保存是完整提交，同一时刻只有一次：

1. `enabled && time` 不是 `00:00–23:59` 的 `HH:MM` 时直接返回 `invalid`，不调用任何端点。
2. `saveUserConfig('auto-update', config)`。失败返回 `failed`，不调用调度接口，保留草稿与 dirty。
3. `setupAutoUpdate(config)`。`result.success` 且（禁用时或响应 data 的 `success !== false`）才算完整成功。
4. 完整成功且 revision 未变：写本地 fallback、清除 touched、推进 revision（使保存前发出的读取失效）、`dirty=false`、success 反馈（`自动更新已启用，每天 <time> 执行` / `自动更新已禁用`）。
5. 完整成功但保存期间出现新编辑：返回 `superseded`，保留新草稿与 dirty，提示“此前设置已保存，当前更改尚未保存”。
6. 配置已保存而调度失败：返回 `failed`，提示 `自动更新设置应用失败: <原因>`，配置不回滚，用户可再次保存重试。

保存期间允许继续编辑；Activity 隐藏或页面重挂载不会中断已提交的保存。owner 是模块级对象，保存完成后即使页面隐藏也会写入状态与全局提示。

## 5. 面板接线

`ConfigManager` 只组合 `SettingsWorkspace`；`SettingsUpdatesPanel` 只提供卡片壳，自动更新策略与组件更新分别由 `AutoUpdateConfigPanel`、`ComponentUpdatePanel` 订阅。两个面板都不导入 `loadUserConfig`、`saveUserConfig`、`updateMaaCore`、`updateMaaCli`、`hotUpdateResources`、`setupAutoUpdate`，也不保存更新/自动更新的页面 state：

| 页面原职责 | 新归属 |
| --- | --- |
| `updating` / `hotUpdating` / `updateInFlightRef` | `SettingsUpdateOwner.running` |
| `updateFeedback` 与资源重试条件 | `SettingsUpdateOwner.feedback` |
| core/渠道/CLI/资源命令与开始/结束提示 | `useSettingsUpdates()` |
| 更新成功后的版本重取 | `useSettingsUpdates()` 调用 `useSettingsVersion().reload()`（`invalidateQueries`） |
| 自动更新 `autoUpdate`/`dirty`/`saving`/`feedback`、touched/revision、本地回退、保存 + 调度 | `AutoUpdateConfigOwner` + `useSettingsAutoUpdate()` |
| 自动更新页内/全局提示 | owner 反馈；hook 转发到全局状态 |

按钮语义保持不变：core/资源按钮显示各自 loading，切换渠道按钮只禁用不 loading，CLI 按钮显示自己的 loading；全部更新按钮在任意命令运行期间禁用。默认渲染结构、DOM、CSS 与文案未改变。

## 6. 兼容与回滚

- 端点、请求体、响应体未改变；未修改服务端。update-core 仍在不传版本时使用 `maa update`，切渠道传 `beta`/`stable`；auto-update 仍先写 user config 再 POST `configure-auto-update`。
- localStorage 键 `autoUpdateConfig` 的写入时机与内容不变（成功加载、每次编辑、保存成功）；新增 `laPlumaItemIconVersion`，只保存物品图标缓存 epoch，不保存业务配置。
- 无 Query key 新增；版本继续复用 `settings/version`；物品图标仍不进入 Query。
- 行为差异：
  - 更新成功后新增 `catalog`/`materials`/`training-plan`/`dashboard-snapshot` 失效发布，关闭 FPR-018 留下的发布端缺口。
  - 资源变化后 `getItemIconUrl()` 从固定 URL 变为 `?v=<epoch>`；epoch 持久化，浏览器刷新后仍与更新前不同。干员头像仍是各页面直接构造的独立 URL，不在此机制内。
  - 版本同步由 `refetchQueries` 改为 `invalidateQueries`，活动页面立即重取，隐藏页面恢复后重取，不再因新鲜期保留旧版本。
  - 更新命令完成提示在 HTTP 返回后立即发出，按钮同时恢复；版本重取在后台继续（迁移前 loading 会覆盖到版本重取结束）。
  - 更新/自动更新的反馈与草稿由模块级 owner 持有：Activity 隐藏与真正重挂载都不丢失；自动更新真正重挂载仍会重读服务端，未保存草稿不会被覆盖；确认保存会清除 touched 并推进 revision，之后的重挂载读取可采用服务端副本。
  - 更新成功后仍不自动重试命令；版本读取沿用 Query 默认的可恢复失败重试。
- 独立回滚范围：`model/updateCommands.ts`、`model/autoUpdateConfig.ts`、`hooks/useSettingsUpdates.ts`、`hooks/useSettingsAutoUpdate.ts`、`features/game-data/model/itemIconCache.ts`、`features/game-data/hooks/useItemIconCacheVersion.ts`、`features/game-data/api/index.ts` 的图标 URL、训练/统计页的图标接线与 `SettingsUpdatesPanel` 接线。回滚后恢复页面 state 与直连调用，不需要数据迁移；`laPlumaItemIconVersion` 可保留为无害的孤立键或手动清除。

## 7. 回归证据

| 测试 | 覆盖 |
| --- | --- |
| `features/settings/model/updateCommands.test.ts` | 渠道目标策略、失败详情新/旧形状、资源重试条件、四条命令互斥与重复忽略、core/渠道/CLI/资源成功与失败文案、网络异常、CLI 不产生页内反馈、无自动重试、reset |
| `features/settings/model/autoUpdateConfig.test.ts` | 服务端采用与本地缓存、后续成功读取清空旧回退警告、迟到读取不覆盖编辑、保存前读取不覆盖已保存草稿、确认保存后重挂载采用服务端副本、服务端失败本地回退与无回退错误、坏服务端载荷与坏本地 JSON、编辑 dirty/revision/反馈清理、无效时间、保存 + 调度完整成功、禁用仍要求调度成功、保存失败不碰调度、内层调度失败、保存期间编辑为 `superseded`、保存互斥、抛错路径、reset |
| `features/game-data/model/itemIconCache.test.ts` | 图标 epoch 初始值、持久化恢复、坏值回退、单调推进、存储不可用与订阅注销 |
| `features/game-data/hooks/useItemIconCacheVersion.test.tsx` | epoch 推进触发使用图标的组件重渲染 |
| `pages/settings/ConfigManager.layout.test.tsx` | 更新命令共享互斥、资源步骤失败重试、失败不发布/不重试/不推进图标 epoch、CLI 成功只重取版本且不推进图标 epoch、core/热更新成功发布四类失效并推进图标 epoch、成功提示先于版本重取、Activity 隐藏期间 core 更新继续且恢复后版本重取、自动更新保存跨 Activity 隐藏、迟到自动更新读取不覆盖编辑、既有自动更新保存/失败/调度失败边界、更新反馈与连接反馈互不串面板 |
| `pages/settings/ConfigManager.subscriptions.test.tsx` | 更新/自动更新/版本状态不重渲染连接表单；自动更新编辑不重渲染组件更新面板；连接草稿编辑不重渲染更新面板 |

面板组合与完整回归清单见[设置领域面板](settings-panel.md)。

针对性命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client exec vitest run \
  src/features/settings/model/updateCommands.test.ts \
  src/features/settings/model/autoUpdateConfig.test.ts \
  src/pages/settings/ConfigManager.layout.test.tsx \
  src/features/game-data/model/itemIconCache.test.ts \
  src/features/game-data/hooks/useItemIconCacheVersion.test.tsx
```

完整 `pnpm --filter la-pluma-next-client verify` 与视觉比对由任务完成记录给出。

## 关联

- [设置设备连接与系统资源](settings-device-and-resources.md)：版本 Query、配置目录与设备命令。
- [设置配置编辑与保存](settings-config-editing.md)：connection 草稿与 section 状态。
- [共享资源归属与失效端口](resource-ownership.md)：作用域词汇、发布/订阅规则与触发映射。
- [配置同步与资源一致性契约](config-sync-and-invalidation.md)：跨页失效关系与 Dashboard 完整快照。
- [Query 缓存与键规范](query-cache.md)：Query key、默认策略与 `settings/version`。
- [前端职责与质量基线](frontend-baseline.md)：Settings 页职责矩阵与 Activity 生命周期。
