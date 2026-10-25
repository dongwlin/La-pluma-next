# 配置同步与资源一致性契约

> [← 返回文档索引](README.md)

本记录描述 `a88628e` 上配置保存、跨页失效与 Dashboard 快照的实际行为，以及后续迁移必须保持或建立的不变量。它是本轮前端页面重构的表征基线：肉鸽配置已由 FPR-013、作业配置已由 FPR-014、自动化配置已由 FPR-015 按目标契约迁移（见[配置持久化协调器](config-persistence.md)第 6.1–6.3 节），三页的加载/保存/重试都由 user-config 协调器通道持有；其余生产逻辑尚未迁移，文中标注为“缺口”的行为由后续资源失效与领域用例任务承接，不能把当前实现当成目标契约。

配置持久化的目标契约（按 key 串行的协调模型、适配器编解码/迁移/完整提交条件与薄 hooks）见[配置持久化协调器](config-persistence.md)。协调器与脱离 React 的竞态回归已交付；三域均已接入。

验证入口见[回归证据](#6-回归证据)与[已知缺口](#5-已知缺口与归属)。文中路径均相对 `client/src`。养成队列的写入、写后刷新与不确定状态见[养成队列命令与写后刷新](training-queue-commands.md)；养成设置的串行提交与计划有效期见[养成设置提交与计划有效期](training-settings-and-plan-validity.md)。

## 1. 三页配置同步对照

三个页面都通过 `features/user-config` 的 `loadUserConfig/saveUserConfig` 读写 `/agent/config/user/<key>`，但与本地草稿、提交串行和完整成功条件的关系不同。

| 项目 | Combat | Roguelike | Automation |
| --- | --- | --- | --- |
| 配置 key | `combat-tasks` | `roguelike-tasks` | `automation-tasks` |
| 本地键 | `combatTaskInputs`、`combatAdvancedParams`、`combatAutoFormation`、`combatCopilotSetExecutionMode`、`combatCopilotSetSelections`、`combatConfigSyncPending` | `roguelikeTaskInputs`、`roguelikeAdvancedParams`、`roguelikeConfigSyncPending` | `maa-task-flow`、`maa-schedule`、`automationConfigSyncPending` |
| 加载优先级 | pending 且本地可恢复 → 仅本地；否则服务端成功 → 服务端并写回本地；服务端失败 → 本地 | 同 Combat | 存在 pending → 仅本地；否则服务端成功 → 服务端并写回本地；服务端失败 → 本地 |
| 坏草稿 | pending 且本地无法恢复 → 删除 pending 后继续读服务端；单个坏 JSON 键删除 | 同 Combat | 坏 JSON 删除 `maa-task-flow`/`maa-schedule`，但保留 pending，后续挂载不再读服务端（见第 5 节） |
| 保存触发 | 配置状态变化，fingerprint 去重，300ms debounce | 同 Combat | 每个编辑处理器直接调用 `autoSave`，无 debounce 与 fingerprint |
| 提交串行范围 | 模块级 Promise 队列，跨 remount 共享 | 同 Combat | 实例级 Promise 队列，remount 后不共享 |
| 版本/令牌 | 页内 revision + localStorage token，提交前后各校验 | 同 Combat | 页内 revision + localStorage token，提交前、配置保存后、schedule 后校验 |
| 失败反馈 | 页内 `role="alert"` + “重新同步” | 同 Combat | 仅全局状态消息，无页内重试 |
| 完整成功条件 | `saveUserConfig` 成功 | `saveUserConfig` 成功 | `saveUserConfig` 成功且 `setupSchedule`/`stopSchedule` 成功 |
| 加载时迁移 | `app` → `cli`；raid `1`/`2` → `raid`/`both` | 无 | schedule `entries`/`times` 兼容；禁用项只保留在本地 |

实现位置：Combat 的适配器见 `features/combat/model/combatConfig.ts`，页面订阅与重试见 `features/combat/pages/CombatTasks.tsx`；Roguelike 的适配器见 `features/roguelike/model/roguelikeConfig.ts`，页面订阅与重试见 `features/roguelike/pages/RoguelikeTasks.tsx`；Automation 的适配器见 `features/automation/model/automationConfig.ts`，页面订阅、完整提交与重试见 `features/automation/pages/AutomationTasks.tsx`。

FPR-013/014/015 之后，表中三列描述的“模块级/实例级队列、页内 revision/token、300ms timer/立即 autoSave、`configHydratedRef`、`configLoaded`”已由 `features/user-config` 协调器通道接管，key、本地键、pending 键与 wire 形状不变。三域现行语义见[配置持久化协调器](config-persistence.md)第 6.1–6.3 节；上表保留迁移前基线以便对照。

三者共享的语义只有“pending 表示本设备有一份尚未确认写入服务端的草稿”。以下不属于共享规则：提交时机、队列寿命、完成条件、迁移与失败恢复——它们在三个域中分别成立，不能用一个通用 hook 抹平。

## 2. 配置生命周期不变量

### 2.1 pending 草稿优先且只能被对应的成功写入清除

`pending` 令牌与 localStorage 草稿一起写入；保存成功后，只有在 revision 仍是当前值且令牌仍是当前令牌时才删除。旧请求的成功/失败回调不得删除新令牌，也不得把服务器旧副本写回页面。

当前证据：三域都由协调器统一校验 revision 与 pending 令牌；Combat/Roguelike 的“旧保存响应不得清除重挂载后的新草稿”与 Automation 的“跨 mount 串行提交、旧提交不确认新 revision”均覆盖该不变量。

### 2.2 跨 remount 的提交次序

页面卸载不会取消已发出的请求；`Activity` 隐藏只清理 Effects，不清理模块级队列或协调器通道。三域的队列都由 `user-config` 通道持有，因此重挂载后的新提交都排在旧请求之后，旧实例的请求不会在新实例之后覆盖服务端文件（FPR-015 之前 Automation 为实例级队列，该缺口已关闭）。

### 2.3 迟到加载不得覆盖编辑

服务端加载在途时用户仍可编辑。目标不变量是：一旦本地出现新草稿或新 revision，迟到的加载响应必须被丢弃。

- Automation：协调器在加载返回时校验加载序号、AbortSignal、revision 与 pending 标记，编辑后的迟到响应返回 `stale`；FPR-015 已将原来的 stale pending `it.fails` 用例转为正常回归。
- Roguelike：协调器在加载返回时校验加载序号、AbortSignal、revision 与 pending 标记，编辑后的迟到响应返回 `stale`；FPR-013 已把原来的 `it.fails` 用例转为正常回归。
- Combat：协调器在加载返回时校验加载序号、AbortSignal、revision 与 pending 标记，编辑后的迟到响应返回 `stale`；FPR-014 已把原来的 `it.fails` 用例转为正常回归。
- Settings：MAA profile 的 `connection` 不是 `user-config` key，读取走 `settings/maa-config` Query，草稿由 `ConnectionConfigOwner` 持有。每次读取携带开始时的 revision/dirty/saving 令牌，编辑、重置或保存后的迟到响应不会被采用；未保存草稿上的 refresh 同样不改页面值。详见[设置配置编辑与保存](settings-config-editing.md)。

### 2.4 Activity 隐藏/恢复

已访问页面由 `Activity` 保活：隐藏保留 state/DOM，清理 Effects；恢复重建 Effects。各页都由协调器通道的 `hydrated` 标记阻止恢复时重复加载，pending 草稿优先。Combat 还会在恢复时清理被中断请求遗留的 loading 状态。现有测试覆盖配置 hydrate 不重载；Combat/Roguelike 的 Activity 用例覆盖隐藏期间提交队列不被页面挂载归属截断，Automation 由卸载/重挂载的串行提交用例覆盖。

### 2.5 失败与重试

保存失败时保留本地草稿与 pending，下一次挂载只读本地，不读取可能更旧的服务端副本。三域的页内警告都带“重新同步”按钮并调用协调器 `retry()`，在途期间按钮保持 loading；成功提示只在用户主动重试确认后出现。Automation 的重试重跑“配置保存 + setup/stop schedule”整段提交；FPR-015 之前只有全局错误消息，该缺口已关闭。

### 2.6 Automation 的完整成功条件

Automation 的一次提交包含两步：

1. `saveUserConfig('automation-tasks', { taskFlow, schedule: { enabled, times } })`；
2. `enabled && times.length > 0` 时 `setupSchedule('default', times, taskFlow)`，否则 `stopSchedule('default')`。

只有两步都成功才清除 pending。配置保存失败时不得调用 schedule 接口；配置已保存而 schedule 失败时 pending 保留，重新加载仍以本地草稿为准。`times` 只包含启用的时间点，禁用项保留在本地 `maa-schedule.entries`。若所有时间点都被禁用，视为需要停止服务端 schedule。

### 2.7 加载时迁移

Combat 的旧 `app` 作业集模式在加载时转换为 `cli`；raid 值 `1`/`2` 规范化为 `raid`/`both`。迁移由适配器在加载路径（服务端成功或本地回退）执行，不额外触发保存；规范化结果在本地立即可见（服务端不可用而采用本地草稿时会回写本地），下一次真实编辑才写回服务端。Roguelike 没有等价的模式迁移；Automation 也没有 `app→cli` 一类迁移，但其适配器继续执行原有的任务参数迁移（如 `skip_robot`→`preserve_tags`），并同时接受旧 `times` 与新 `entries`。

## 3. 跨页失效关系

目标模型是“写入成功后由命令/用例协调刷新受影响资源”，而不是页面各自轮询另一页的状态。下表的“现状”是本次表征基线，不是既定契约。

| 触发 | 受影响资源或状态 | 必须保留的语义 | 现状与证据 |
| --- | --- | --- | --- |
| 仓库识别完成 | depot、持有干员、养成候选/计数、材料进度、总览 | 命令完成后协调刷新；命令本身不作为自动重试 query | 已由 FPR-020 交付：命令所有者提交 Run、等待解析；页面写入 depot 快照，命令所有者发布 `depot`/`materials`/`training-queue`/`dashboard-snapshot`（见[统计识别命令与失效联动](statistics-commands.md)）。FPR-044 起训练候选/计数 query 按 `depot`/`materials` 作用域失效 |
| 干员识别完成 | 持有干员、养成候选/计数、材料进度、总览 | 同仓库识别 | 已由 FPR-020 交付：页面写入 operbox 快照，命令所有者发布 `operbox`/`materials`/`training-queue`/`dashboard-snapshot`。FPR-044 起候选/计数 query 按 `operbox`/`materials` 失效 |
| 材料刷新完成 | 养成候选/计数、材料进度、总览 | 刷新成功才失效；不把脚本入口当作设备执行 | 已由 FPR-020 交付：发布 `materials`/`training-queue`/`dashboard-snapshot`；不再为提示重读训练队列。FPR-044 起候选/计数 query 按 `materials` 失效 |
| 养成队列变更 | queue、材料进度、计划有效期、相关摘要 | 写成功而刷新失败保留可解释 fallback，禁用过期计划 | 已由 FPR-021 交付：队列是 `training/queue` 的 Query 唯一快照，增删/排序/撤销由串行领域命令执行；写后刷新成功提交权威快照，失败在最新缓存上回退并标记 `uncertain`；命令开始时作废旧计划，revision 变化时再次清空；发布 `training-queue`/`materials`/`training-plan`/`dashboard-snapshot`（见[养成队列命令与写后刷新](training-queue-commands.md)） |
| 养成设置变更 | 计划有效期 | 设置成功使旧计划失效 | 已由 FPR-022 交付：设置由 `features/training/model/settingsCommands.ts` 串行提交并维护本地 revision，编辑/归一化/回滚/权威重读采用外部值都会作废旧计划；队列刷新失败时禁用计划预览与应用（见[养成设置提交与计划有效期](training-settings-and-plan-validity.md)） |
| 生成计划 | 计划版本 | 旧版本不得应用；queue revision 不符时拒绝 | 生成前重读 queue，响应 revision 不符时拒绝并刷新重试（已有测试） |
| 应用计划 | automation 配置/schedule、计划版本、总览 | 写入成功通知相关域；部分失败可识别；本地 pending 草稿不被外部副本覆盖 | 已由 FPR-023 交付：`TrainingPlanOwner` 先经配置协调器排空本设备 automation 在途保存，再应用并发布 `automation-config`/`automation-schedule`/`dashboard-snapshot`（`cause: plan-applied`，`detail` 含关卡数）；automation 等到通道空闲后强制重读，失败草稿保留本地并提示；服务端重新注册已存在的默认定时任务，失败以 `scheduleSync` 上报为部分成功；Dashboard 立即走完整快照刷新。window `training-plan-applied` 已移除 |
| 搜索/预览切换 | 对应查询键与本地选择 | 旧响应不覆盖新选择 | request id/generation 丢弃旧响应；FPR-044 候选 query 以筛选参数分 key，迟到响应只写旧 key，隐藏期间读取随 signal 取消（已有测试） |
| Dashboard 刷新 | 完整业务快照、独立设备采样 | 业务数据全部有效才提交快照，采样失败保旧值 | 见第 4 节（已有测试） |
| 资源/热更新成功 | 目录、图标/资源元数据、养成候选/计数、计划有效性、总览 | 先确定影响范围，不整体清空缓存 | 已由 FPR-026 交付：`SettingsUpdateOwner` 成功确认后由适配层失效 `settings/version` 并发布 `catalog`/`materials`/`training-plan`/`dashboard-snapshot`；CLI 只失效版本；不发布 `depot`/`operbox`，不调用 `queryClient.clear()` |

应用计划的跨页链路当前是“训练域派发 window 事件 → automation 监听后强制 `loadTaskFlow`”。事件不带 `stageCount`，automation 从 `event.detail` 读不到时提示 0 关；后续应由领域失效协议携带明确影响范围，而不是继续扩大 window 事件。

FPR-018 已交付[共享资源归属与失效端口](resource-ownership.md)：`features/resource-invalidation` 提供显式作用域发布/订阅，`OperatorTraining` 与 `Dashboard` 已接入最小接收（总览仍走完整快照刷新）。FPR-020 已接入识别与材料刷新的发布端；FPR-044 把训练页的候选/计数改为领域 query，接收端口后按作用域失效，队列失效仍只重读队列。FPR-021 已接入队列写入的发布端并让队列本身由 `training/queue` query 与串行命令持有；FPR-022 把设置提交集中在 `features/training/model/settingsCommands.ts`，设置变化通过本地 revision 与权威重读使旧计划失效（服务端队列 revision 不含设置）。FPR-023 把计划生成/应用/同步迁到 `features/training/model/planCommands.ts`，应用成功发布 automation 配置、定时与总览作用域，**取代** `training-plan-applied` window 事件；automation 页面改为订阅同一失效端口，并在处理前排空配置通道。资源更新的发布端已由 FPR-026 接入：`features/settings/model/updateCommands.ts` 持有 core/渠道/CLI/热更新命令，`hooks/useSettingsUpdates.ts` 在确认成功后发布上述作用域并失效版本 Query。

## 4. Dashboard 完整快照规则

`features/dashboard/pages/Dashboard.tsx` 的 `refreshDashboardData` 与 `features/dashboard/store/dashboardStore.ts` 共同构成受控投影：

1. **单飞**：模块级 `dashboardRefreshPromise` 保证同时只有一个业务刷新；`force` 会先等在途刷新结束再补一次。
2. **五项业务读取**：activity、schedule execution、training queue、today drops、open-today stages 并发读取；五项都必须 fulfilled 且 `success === true`。
3. **payload 校验**：activity 必须是对象且 `completion` 形状合法；queue 必须可解析为对象数组；drops 必须是对象数组；open/closed 必须是 `{stage,name}` 数组。任一 payload 不合法视为本次快照无效。
4. **后端探测不参与快照有效性**：`probeBackendAvailability` 有自己的 revision 处理且可能被应用级监测取代；它失败不否决其他五项已成功的数据，也不把状态写成“任务完成”。
5. **原子提交**：只有完整快照才交给 `finishRefresh`；`finishRefresh` 合并当前设备采样与温度历史，写入 `lastUpdate = attemptedAt` 并持久化。无快照时保留旧业务值、旧 `lastUpdate`，只更新 `lastRefreshAttemptAt`。
6. **设备采样独立**：页面立即采样一次，之后每 5s 单飞；失败保留上一份样本；无效样本（百分比越界、非有限数值、形状错误）被 `updateDeviceStats` 拒绝，不污染缓存。
7. **缓存持久化 v1**：只持久化完整业务快照与设备/温度投影；恢复时校验版本、形状、语义边界与未来时钟偏差（60s 内夹紧，超出拒绝）；最多保留 36 个温度点。失败刷新不覆盖最近一次成功缓存。
8. **调度**：距 `lastRefreshAttemptAt` 满 5 分钟刷新；缓存新鲜时只排下一次；online 恢复强制刷新。首次无缓存显示骨架，恢复缓存后不回到骨架；页面不提供手动刷新按钮。

这些规则共同保证：Dashboard 展示的是一份彼此同期的业务快照，而不是五个请求各写各的混合状态；设备采样可以更新，但不会把不完整的业务响应带进快照。

FPR-017 的 Query 缓存只服务资源读取，不改变上述条件：不得把五路 query 的逐块结果直接写入 `dashboardStore`，完整快照校验与原子提交仍由 Dashboard 协调层持有，见 [Query 缓存与键规范](query-cache.md) 第 7 节。

## 5. 已知缺口与归属

| # | 缺口 | 可复现证据 | 后续归属 |
| --- | --- | --- | --- |
| 1 | ~~Automation 只有 pending、没有本地草稿时永远不读服务端~~ 已由 FPR-015 关闭：协调器删除无草稿的标记并改读服务端 | `automationConfig.test.ts` 与 `AutomationTasks.config.test.tsx` 的“pending marker has no local draft”用例 | 已完成（[目标契约](config-persistence.md) 6.3） |
| 2 | ~~Automation 提交队列是实例级，跨 remount 的旧请求可能后到覆盖服务端文件~~ 已由 FPR-015 关闭：通道按 key 复用队列 | `AutomationTasks.config.test.tsx` 的跨 mount 串行提交用例 | 已完成 |
| 3 | ~~Automation 配置已保存但 schedule 失败时只有全局消息，没有页内重试~~ 已由 FPR-015 关闭：页内 alert + “重新同步”重跑整段提交 | `AutomationTasks.config.test.tsx` 的半失败重试用例 | 已完成 |
| 4 | ~~养成设置保存成功后不使已生成计划失效~~ 已由 FPR-022 关闭：设置所有者维护本地 revision，编辑立即作废旧计划，成功/回滚/外部采用同步推进版本 | `OperatorTraining.test.tsx` 的设置作废旧计划用例；`settingsCommands.test.ts`、`planValidity.test.ts` | 已完成（[结论](training-settings-and-plan-validity.md)） |
| 5 | ~~仓库/干员识别完成不发布跨页失效；训练候选/计数/材料与 Dashboard 不会自动刷新~~ 已由 FPR-020 关闭：命令所有者解析成功后才发布 `depot`/`operbox`/`materials`/`training-queue`/`dashboard-snapshot` | `statistics/model/commandOwner.test.ts` 的发布作用域用例与 `DataStatistics.layout.test.tsx` 的识别快照/失效用例 | 已完成（[统计识别命令与失效联动](statistics-commands.md)） |
| 6 | ~~应用计划只触发 automation 重载；Dashboard 不立即失效，事件也不携带影响范围~~ 已由 FPR-023 关闭：计划所有者发布 `automation-config`/`automation-schedule`/`dashboard-snapshot`，automation 经端口重读，Dashboard 立即刷新 | `planCommands.test.ts`、`AutomationTasks.config.test.tsx`、`Dashboard.test.tsx` 的 plan-applied 用例 | 已完成（[计划编排与有效期](training-settings-and-plan-validity.md)） |
| 7 | ~~资源/热更新成功后目录、图标、候选/计数与总览没有失效路径~~ 已由 FPR-026 关闭：更新成功后适配层失效 `settings/version` 并发布 `catalog`/`materials`/`training-plan`/`dashboard-snapshot`；只发布确认受影响的作用域 | `updateCommands.test.ts`、`ConfigManager.layout.test.tsx` 的更新成功/失败/CLI 用例 | 已完成（[设置组件更新与自动更新](settings-updates-and-auto-update.md)） |

预期失败用例使用 Vitest 的 `it.fails`：当前行为确实不满足断言，CI 保持绿色；修复落地后该用例会转为失败，承接任务必须删除 `.fails` 标记并保留断言，作为新行为的回归测试。不得用删除断言或改写预期来“修复”这些用例。FPR-015 已将 Automation 的 stale pending 用例转为正常回归。

## 6. 回归证据

| 测试文件 | 覆盖 |
| --- | --- |
| `features/combat/model/combatConfig.test.ts` | 作业适配器：原 key/pending/本地键/300ms、wire 形状与解码校验、`app→cli` 与 raid `1`/`2` 迁移、坏本地键清理、完整提交与读取失败信封 |
| `features/combat/pages/CombatTasks.test.tsx` | pending 跨 remount + 手动重试；重试防重入与成功提示；旧保存响应不清新令牌；`app→cli` 与 raid 迁移（服务端/本地）；迟到加载不覆盖编辑；坏草稿回退服务端；set 模式与待执行索引回填；Activity 恢复；搜索/预览竞态 |
| `features/roguelike/model/roguelikeConfig.test.ts` | 肉鸽适配器：原 key/pending/本地键/300ms、wire 形状与解码校验、坏本地键清理、完整提交与读取失败信封 |
| `features/roguelike/pages/RoguelikeTasks.test.tsx` | pending 跨 remount + 重试；重试防重入与成功提示；提交串行；旧响应不清新令牌；坏草稿回退服务端；迟到加载不覆盖编辑；Activity 恢复；另含 FPR-008 的执行接线用例（Run 提交/停止/恢复） |
| `features/automation/model/automationConfig.test.ts` | 自动化适配器：原 key/pending/本地键/立即提交；wire 去掉界面字段、禁用 schedule 项只留本地；`entries`/`times` 兼容与任务参数迁移；配置+schedule 完整成功、半失败、保存期间新草稿跳过旧 schedule；草稿指纹覆盖本地 `entries` |
| `features/automation/pages/AutomationTasks.config.test.tsx` | 配置 + schedule 完整成功；保存失败不碰 schedule；schedule 半失败保留 pending 并可从页内重试；disabled/全禁用走 stop；编辑/删除禁用时间点仍写回本地并触发提交；跨 mount 串行提交与旧提交不确认新 revision；迟到加载保护；stale pending 回退服务端；应用计划强制重读与 pending 草稿冲突裁决 |
| `features/automation/pages/AutomationTasks.layout.test.tsx` | pending 本地优先；在途服务端响应不覆盖新草稿；hydrate 不重建 schedule；Activity 恢复 |
| `features/statistics/model/commandOwner.test.ts` | 识别/材料命令的控制器 intent、幂等复用、日志解析等待、超时/取消/继续与失效发布 |
| `features/statistics/pages/DataStatistics.layout.test.tsx` | 识别快照写入 Query 并发布作用域；按作用域失效；运行中不重复提交；超时后继续解析；各数据源独立错误与重试；Activity 恢复 |
| `features/training/pages/OperatorTraining.test.tsx` | FPR-021 队列命令接线、写后刷新失败 fallback/警告/重载、跨页失效与自发布忽略、并发排序；队列变更废弃旧计划；queue revision 校验；FPR-044 候选/计数 Query、列表失败/计数保旧、目录失败与仅计数失败、筛选迟到响应与 Activity 恢复；FPR-022 设置串行/跨重挂载/失败回滚、设置变更作废旧计划、刷新失败禁用生成与应用；FPR-023 计划编排迁移、生成期间版本变化、应用等待在途配置保存、部分成功重读、三类失效发布 |
| `features/training/model/settingsCommands.test.ts` | 设置串行写入、旧响应不覆盖最新值、旧失败不打断新草稿、最新失败回滚、服务端归一化、hydrate 与显式重读、reset 丢弃迟到响应 |
| `features/training/model/planCommands.test.ts` | 生成/应用版本裁决、重复触发合并、automation 配置写入屏障、应用后重读与 schedule 部分成功、失效发布 |
| `features/training/model/planValidity.test.ts` | 计划 basis 捕获、队列/设置版本比较、刷新失败与版本失效下的生成/应用门禁 |
| `features/training/model/candidates.test.ts` | 候选旧载荷、`all` 补齐、计数来源与 `all=0` 保留、结构共享引用稳定 |
| `features/training/model/queueCommands.test.ts` | 队列命令串行、最新快照排序、重复命令合并、写后刷新失败与不确定状态、失败不提交不发布、撤销原索引 |
| `features/training/model/queries.test.ts` | `queue`/`candidates`/`counts` key、筛选参数、signal、失败信封、补齐读取与计数结构共享 |
| `features/dashboard/pages/Dashboard.test.tsx` | 完整快照原子提交；单请求失败/形状错误保旧；设备采样失败保旧；缓存恢复与后台刷新；FPR-018 资源失效触发完整刷新且单路失败保留旧快照 |
| `features/dashboard/store/dashboardStore.test.ts` | 缓存版本/形状/时钟偏差/语义边界校验；设备采样合并；失败刷新不覆盖成功缓存 |
| `features/resource-invalidation/model/resourceInvalidation.test.ts` | 失效作用域去重、revision、注销与监听器隔离 |
| `features/resource-invalidation/hooks/useResourceInvalidation.test.tsx` | 作用域过滤、Activity 隐藏/恢复补发与卸载注销 |
| `features/settings/model/connectionConfig.test.ts` | connection 读取令牌、编辑/重置/保存后的迟到响应丢弃、保存串行与失败重试 |
| `features/settings/model/autoUpdateConfig.test.ts` | 自动更新服务端/本地回退、迟到读取不覆盖编辑、保存与调度完整成功、半失败与 `superseded`（FPR-026） |
| `features/settings/model/updateCommands.test.ts` | 更新命令互斥、失败重试条件与成功作用域声明（FPR-026） |
| `features/settings/pages/ConfigManager.layout.test.tsx` | 初始加载与 refresh 不覆盖编辑、保存期间继续编辑、section 切换与监听清理、Activity 恢复；更新成功发布四类失效、CLI 只失效版本、失败不发布不重试、自动更新保存跨 Activity 隐藏（FPR-026） |

复现命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client verify
```

FPR-015 将 Automation 的配置读写迁到 `features/automation/model/automationConfig.ts` 与 user-config 协调器，配置 key、本地键、pending 键、wire 形状与默认渲染不变；失败时新增与其余两域一致的页内重试条。其余记录项未改变生产源码或存储格式。

## 关联

- [前端职责与质量基线](frontend-baseline.md)：八页职责矩阵、生命周期与性能入口。
- [执行身份与生命周期契约](execution-lifecycle.md)：Run 身份、停止与恢复边界。
- [开发文档](development.md)：测试治理与常用检查。
