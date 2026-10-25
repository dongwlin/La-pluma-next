# 配置同步与资源一致性契约

> [← 返回文档索引](README.md)

本记录描述 `a88628e` 上配置保存、跨页失效与 Dashboard 快照的实际行为，以及后续迁移必须保持或建立的不变量。它是本轮前端页面重构的表征基线：肉鸽配置已由 FPR-013 按目标契约迁移（见[配置持久化协调器](config-persistence.md)第 6.1 节），其余生产逻辑尚未迁移；文中标注为“缺口”的行为由后续配置持久化、资源失效与领域用例任务承接，不能把当前实现当成目标契约。

配置持久化的目标契约（按 key 串行的协调模型、适配器编解码/迁移/完整提交条件与薄 hooks）见[配置持久化协调器](config-persistence.md)。协调器与脱离 React 的竞态回归已交付；肉鸽已在 FPR-013 接入，作业与自动化仍使用本文件第 1–2 节描述的迁移前实现。

验证入口见[回归证据](#6-回归证据)与[已知缺口](#5-已知缺口与归属)。文中路径均相对 `client/src`。

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

实现位置：Combat 的模块队列与令牌见 `features/combat/pages/CombatTasks.tsx:47`，加载与迁移见 `:281`、`:385`、`:407`，自动保存见 `:467`；Roguelike 的适配器见 `features/roguelike/model/roguelikeConfig.ts`，页面订阅与重试见 `features/roguelike/pages/RoguelikeTasks.tsx`；Automation 的完整提交见 `features/automation/pages/AutomationTasks.tsx:1242`，加载见 `:1374`，schedule 编辑入口见 `:1297`、`:1473`。

FPR-013 之后，Roguelike 一列中的“模块级队列、页内 revision/token、300ms timer、`configHydratedRef`”已由 `features/user-config` 协调器通道接管，key、本地键、pending 键与 wire 形状不变；表中其余两列仍是迁移前实现。肉鸽现行语义见[配置持久化协调器](config-persistence.md)第 6.1 节。

三者共享的语义只有“pending 表示本设备有一份尚未确认写入服务端的草稿”。以下不属于共享规则：提交时机、队列寿命、完成条件、迁移与失败恢复——它们在三个域中分别成立，不能用一个通用 hook 抹平。

## 2. 配置生命周期不变量

### 2.1 pending 草稿优先且只能被对应的成功写入清除

`pending` 令牌与 localStorage 草稿一起写入；保存成功后，只有在 revision 仍是当前值且令牌仍是当前令牌时才删除。旧请求的成功/失败回调不得删除新令牌，也不得把服务器旧副本写回页面。

当前证据：Combat 与 Roguelike 的“旧保存响应不得清除重挂载后的新草稿”、Automation 的跨 mount 令牌测试。三者都成立；Roguelike 由协调器统一校验 revision 与 pending 令牌。

### 2.2 跨 remount 的提交次序

页面卸载不会取消已发出的请求；`Activity` 隐藏只清理 Effects，不清理模块级队列或协调器通道。Combat 的队列位于模块作用域，Roguelike 的队列由 `user-config` 通道持有，因此重挂载后的新提交都排在旧请求之后；Automation 的队列位于组件实例，重挂载后新实例可以立即发起提交，旧实例的请求仍可能后到并覆盖服务端文件（见第 5 节）。

### 2.3 迟到加载不得覆盖编辑

服务端加载在途时用户仍可编辑。目标不变量是：一旦本地出现新草稿或新 revision，迟到的加载响应必须被丢弃。

- Automation：`loadTaskFlow` 同时校验 request id、AbortSignal、`autoSaveRevisionRef` 与 pending 令牌；编辑触发 `autoSave` 后 revision 改变，迟到响应被丢弃。已有回归测试。
- Roguelike：协调器在加载返回时校验加载序号、AbortSignal、revision 与 pending 标记，编辑后的迟到响应返回 `stale`；FPR-013 已把原来的 `it.fails` 用例转为正常回归。
- Combat：当前只在卸载时 `cancelled`，没有编辑 revision 校验；服务端响应会覆盖加载期间输入的值。已用预期失败测试记录，见第 5 节。

### 2.4 Activity 隐藏/恢复

已访问页面由 `Activity` 保活：隐藏保留 state/DOM，清理 Effects；恢复重建 Effects。各页都有已加载守卫阻止恢复时重复加载（Combat 为 `configHydratedRef`，Roguelike 为协调器通道的 `hydrated` 标记，Automation 为 `taskFlowHydratedRef`），pending 草稿优先。Combat 还会在恢复时清理被中断请求遗留的 loading 状态。现有测试覆盖配置 hydrate 不重载；Roguelike 的 Activity 用例还覆盖隐藏期间提交队列不被页面挂载归属截断。

### 2.5 失败与重试

保存失败时保留本地草稿与 pending，下一次挂载只读本地，不读取可能更旧的服务端副本。Combat 提供页内“重新同步”；Roguelike 的“重新同步”调用协调器 `retry()`，在途期间按钮保持 loading 且不会重复入队，成功提示只在用户主动重试确认后出现（FPR-013）；Automation 只显示全局错误消息，失败后由下一次编辑重新触发完整提交，见第 5 节。

### 2.6 Automation 的完整成功条件

Automation 的一次提交包含两步：

1. `saveUserConfig('automation-tasks', { taskFlow, schedule: { enabled, times } })`；
2. `enabled && times.length > 0` 时 `setupSchedule('default', times, taskFlow)`，否则 `stopSchedule('default')`。

只有两步都成功才清除 pending。配置保存失败时不得调用 schedule 接口；配置已保存而 schedule 失败时 pending 保留，重新加载仍以本地草稿为准。`times` 只包含启用的时间点，禁用项保留在本地 `maa-schedule.entries`。若所有时间点都被禁用，视为需要停止服务端 schedule。

### 2.7 加载时迁移

Combat 的旧 `app` 作业集模式在加载时转换为 `cli`；raid 值 `1`/`2` 规范化为 `raid`/`both`。迁移发生在加载路径（服务端成功或本地回退），不额外触发保存；规范化结果在本地立即可见，下一次真实编辑才写回服务端。Roguelike 与 Automation 没有等价的模式迁移；Automation 的 `readScheduleEntries` 同时接受旧 `times` 与新 `entries`。

## 3. 跨页失效关系

目标模型是“写入成功后由命令/用例协调刷新受影响资源”，而不是页面各自轮询另一页的状态。下表的“现状”是本次表征基线，不是既定契约。

| 触发 | 受影响资源或状态 | 必须保留的语义 | 现状与证据 |
| --- | --- | --- | --- |
| 仓库识别完成 | depot、持有干员、养成候选/计数、材料进度、总览 | 命令完成后协调刷新；命令本身不作为自动重试 query | 只更新本页 depot，并读一次 training queue 决定提示文案；不发布跨页失效（见第 5 节） |
| 干员识别完成 | 持有干员、养成候选/计数、材料进度、总览 | 同仓库识别 | 只更新本页 operbox（见第 5 节） |
| 养成队列变更 | queue、材料进度、计划有效期、相关摘要 | 写成功而刷新失败保留可解释 fallback，禁用过期计划 | 成功后重读 queue；写操作开始即废弃旧计划；queue revision 变化时清空计划（已有测试） |
| 养成设置变更 | 计划有效期 | 设置成功使旧计划失效 | 当前不清理已生成计划（见第 5 节） |
| 生成计划 | 计划版本 | 旧版本不得应用；queue revision 不符时拒绝 | 生成前重读 queue，响应 revision 不符时拒绝并刷新重试（已有测试） |
| 应用计划 | automation 配置/schedule、计划版本、总览 | 写入成功通知相关域；部分失败可识别 | 应用成功派发 `training-plan-applied`（无 detail），automation 强制重载配置；Dashboard 等下一次定时刷新（见第 5 节） |
| 搜索/预览切换 | 对应查询键与本地选择 | 旧响应不覆盖新选择 | request id/generation 丢弃旧响应（已有测试） |
| Dashboard 刷新 | 完整业务快照、独立设备采样 | 业务数据全部有效才提交快照，采样失败保旧值 | 见第 4 节（已有测试） |
| 资源/热更新成功 | 目录、图标/资源元数据、养成候选/计数、计划有效性、总览 | 先确定影响范围，不整体清空缓存 | 当前只重读版本，未发布资源失效（见第 5 节） |

应用计划的跨页链路当前是“训练域派发 window 事件 → automation 监听后强制 `loadTaskFlow`”。事件不带 `stageCount`，automation 从 `event.detail` 读不到时提示 0 关；后续应由领域失效协议携带明确影响范围，而不是继续扩大 window 事件。

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

## 5. 已知缺口与归属

| # | 缺口 | 可复现证据 | 后续归属 |
| --- | --- | --- | --- |
| 1 | Combat 的迟到服务端加载覆盖加载期间的编辑（Roguelike 已由 FPR-013 修复） | `CombatTasks.test.tsx` 的 `it.fails` 用例；Roguelike 的对应用例已转为正常回归 | 配置持久化协调器 + combat 适配器（FPR-014，[目标契约](config-persistence.md)） |
| 2 | Automation 只有 pending、没有本地草稿时永远不读服务端 | `AutomationTasks.config.test.tsx` 的 `it.fails` 用例 | automation 配置适配器 + 协调器（[目标契约](config-persistence.md)） |
| 3 | Automation 提交队列是实例级，跨 remount 的旧请求可能后到覆盖服务端文件 | 代码结构；跨 mount 令牌测试只能证明旧响应不会清 pending | 配置持久化协调器（通道按 key 复用队列，[目标契约](config-persistence.md)） |
| 4 | Automation 配置已保存但 schedule 失败时只有全局消息，没有页内重试；pending 只能靠下一次编辑解除 | 完整成功条件测试 | automation 配置适配器（完整提交条件 + `retry()`，[目标契约](config-persistence.md)） |
| 5 | 养成设置保存成功后不使已生成计划失效 | `OperatorTraining.test.tsx` 的 `it.fails` 用例 | 训练设置/计划有效期 |
| 6 | 仓库/干员识别完成不发布跨页失效；训练候选/计数/材料与 Dashboard 不会自动刷新 | `DataStatistics.layout.test.tsx` 的识别完成用例（仅本页 + 读 queue） | 资源失效与统计识别联动 |
| 7 | 应用计划只触发 automation 重载；Dashboard 不立即失效，事件也不携带影响范围 | training 事件用例 + automation 重载用例 | 计划应用联动 + Dashboard 快照协调 |
| 8 | 资源/热更新成功后目录、图标、候选/计数与总览没有失效路径 | 仅重读版本，无事件 | 更新流程与资源失效 |

预期失败用例使用 Vitest 的 `it.fails`：当前行为确实不满足断言，CI 保持绿色；修复落地后该用例会转为失败，承接任务必须删除 `.fails` 标记并保留断言，作为新行为的回归测试。不得用删除断言或改写预期来“修复”这些用例。

## 6. 回归证据

| 测试文件 | 覆盖 |
| --- | --- |
| `features/combat/pages/CombatTasks.test.tsx` | pending 跨 remount + 手动重试；旧保存响应不清新令牌；`app→cli` 与 raid 迁移（服务端/本地）；迟到加载缺口；Activity 恢复；搜索/预览竞态 |
| `features/roguelike/model/roguelikeConfig.test.ts` | 肉鸽适配器：原 key/pending/本地键/300ms、wire 形状与解码校验、坏本地键清理、完整提交与读取失败信封 |
| `features/roguelike/pages/RoguelikeTasks.test.tsx` | pending 跨 remount + 重试；重试防重入与成功提示；提交串行；旧响应不清新令牌；坏草稿回退服务端；迟到加载不覆盖编辑；Activity 恢复；另含 FPR-008 的执行接线用例（Run 提交/停止/恢复） |
| `features/automation/pages/AutomationTasks.config.test.tsx` | 配置 + schedule 完整成功；保存失败不碰 schedule；schedule 半失败保留 pending；disabled/全禁用走 stop；跨 mount 旧响应保护；迟到加载保护；stale pending 缺口；应用计划事件重载 |
| `features/automation/pages/AutomationTasks.layout.test.tsx` | pending 本地优先；在途服务端响应不覆盖新草稿；hydrate 不重建 schedule；Activity 恢复 |
| `features/statistics/pages/DataStatistics.layout.test.tsx` | 识别完成只更新本页并读一次 queue；各数据源独立错误与重试；Activity 恢复 |
| `features/training/pages/OperatorTraining.test.tsx` | 队列变更废弃旧计划；queue revision 校验；设置写串行；应用计划事件；设置变更不失效计划的缺口 |
| `features/dashboard/pages/Dashboard.test.tsx` | 完整快照原子提交；单请求失败/形状错误保旧；设备采样失败保旧；缓存恢复与后台刷新 |
| `features/dashboard/store/dashboardStore.test.ts` | 缓存版本/形状/时钟偏差/语义边界校验；设备采样合并；失败刷新不覆盖成功缓存 |

复现命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client verify
```

本记录只新增测试与文档，生产源码、配置 key、存储格式和视觉基线未改动。测试可独立回滚；回滚后不改变任何新旧协议的支持窗口。

## 关联

- [前端职责与质量基线](frontend-baseline.md)：八页职责矩阵、生命周期与性能入口。
- [执行身份与生命周期契约](execution-lifecycle.md)：Run 身份、停止与恢复边界。
- [开发文档](development.md)：测试治理与常用检查。
