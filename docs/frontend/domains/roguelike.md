# 肉鸽

> [← 返回前端架构](../README.md) · [文档索引](../../README.md)

本文集中维护本领域的面板、模型与命令约定；通用契约通过链接引用。

- [页面、配置与命令](#页面配置与命令)
- [回归与关联](#回归与关联)

## 页面、配置与命令

配置草稿仍由 `user-config` 协调器持有，运行身份仍由 `task-execution` 控制器持有；页面/面板分别持有界面组合与只读数据投影，不新增第二份持久化或执行状态。

### 1. 定位与边界

| 内容 | 唯一归属 | 说明 |
| --- | --- | --- |
| 页面壳、页头与预览布局 | `pages/roguelike/RoguelikeTasks.tsx` | 只渲染 `app-page`/`app-stack-section`、`PageHeader` 与工作区 |
| 当前模式、配置订阅、执行订阅与同步反馈 | `features/roguelike/components/RoguelikeWorkspace.tsx` | 跨面板状态的唯一容器；模式选择不写入持久化载荷 |
| 模式分段控件的测量与键盘导航 | `features/roguelike/components/RoguelikeModePanel.tsx` | 受控组件；只持有 `useFluidTabIndicator` 的测量状态 |
| 主题快捷项与自定义代号 | `features/roguelike/components/RoguelikeThemePanel.tsx` | 从草稿派生值，编辑经回调交给工作区 |
| 高级字段与运行/停止按钮 | `features/roguelike/components/RoguelikeSettingsPanel.tsx` | 只渲染当前生效的字段并调用注入的执行动作，不创建执行状态机 |
| 配置 key、本地草稿、pending 与 300ms 提交 | `features/roguelike/model/roguelikeConfig.ts` + `features/user-config` | 配置适配器维持 key、本地键和 wire 协议 |
| 策略字段表、主题相关下拉项与适用条件 | `features/roguelike/model/roguelikeOptions.ts` | 纯数据与候选项解析：主题分队、职业组、模式与难度 |
| 任务目录、主题快捷项、可见性、默认值、命令拼接、草稿归一化与输入校验 | `features/roguelike/model/roguelikeTasks.ts` | 纯模型，不访问 React、Query、配置通道或网络 |
| 运行提交、观察、停止与终态提示 | `features/roguelike/hooks/useRoguelikeExecution.ts` + `task-execution` | 页面只订阅一份快照并发送意图 |

维护约束：

- 不持久化 `activeMode`，也不把模式选择写进 `roguelike-tasks` 配置。
- 不改变服务端端点、配置 key、本地存储键或 wire 形状。
- 不在面板内复制配置、pending、停止确认或终态提示状态。

### 2. 组合与状态边界

```
RoguelikeTasks（页面壳：页头、预览布局）
└─ RoguelikeWorkspace（配置/执行/模式唯一容器）
   ├─ RoguelikeModePanel（受控分段控件 + 高亮测量）
   ├─ RoguelikeThemePanel（主题快捷项 + 自定义输入）
   ├─ RoguelikeSettingsPanel（高级字段 + 运行/停止按钮）
   └─ aside（DeviceMonitorPanel，共享实时会话）
```

- **当前模式**是跨面板的局部交互状态：它决定主题与高级字段面板展示哪一份 `taskInputs`/`advancedParams`。它不进入配置 wire；`Activity` 隐藏/恢复保留，真正卸载或刷新后回到默认的 `roguelike`。
- **配置草稿**只由工作区的一次 `useUserConfig(roguelikeConfigAdapter)` 读取。主题与高级字段编辑分别合并当前 `taskInputs`/`advancedParams` 后交给同一个通道；页面、面板都不直接调用 `saveUserConfig`/`loadUserConfig` 或写 `localStorage`。
- **同步反馈**由工作区从通道的 `error`/`syncState` 派生：失败时显示页内 `role="alert"` 与“重新同步”，`syncState === 'saving'` 期间按钮显示“同步中”；只有手动 `retry()` 返回 true 才提示“肉鸽配置已同步”。
- **执行**只由工作区的一次 `useRoguelikeExecution` 订阅。设置面板拿到的是 `isRunning`/`isStopping`/`isSubmitting` 与 `onExecute`/`onStop` 投影；停止确认、终态提示和 run 身份仍由 hook/控制器持有，面板没有第二份状态机。
- 模式面板只保存 `useFluidTabIndicator` 的容器 ref、高亮矩形与键盘处理；这些测量状态不参与配置或执行。

### 3. 纯命令模型

字段与候选项归 `features/roguelike/model/roguelikeOptions.ts`，命令规则归 `roguelikeTasks.ts`：

| 导出 | 作用 |
| --- | --- |
| `ROGUELIKE_TASKS` | 集成战略/生息演算的任务名、命令、图标、占位与描述 |
| `ROGUELIKE_THEME_PRESETS` | 各模式的主题快捷项；只影响界面，不进入 wire |
| `DEFAULT_RECLAMATION_MODE` | 生息演算默认模式 `'1'`，与 CLI 的 `-m` 缺省一致 |
| `getRoguelikeAdvancedOptions(taskId)` | 策略字段表及其 CLI 参数名，含 `defaultValue`、`hint`、`themes`、`modes` 与 `requires`；未知任务返回空表 |
| `getRoguelikeOptionChoices(option, theme)` | 下拉项：模式、难度、分队与职业组按主题返回候选，其余字段用静态 `options` |
| `resolveRoguelikeAdvancedValue(option, advanced, theme)` | 字段显示值：显式值优先，其次默认值，select 最后回落到当前主题的首项 |
| `isRoguelikeOptionVisible(option, taskId, theme, advanced)` | 字段在当前主题、模式与依赖字段下是否生效；隐藏字段既不下发也不显示 |
| `isRoguelikeOptionValueValid(option, theme, value)` | 下拉值是否属于当前主题的候选表；非下拉字段恒为有效 |
| `normalizeRoguelikeModeForTheme(taskId, theme, advancedParams)` | 切主题时把新主题不支持的模式重置为首项，其余字段保留 |
| `splitRoguelikeListValue(value)` | 列表字段按逗号、顿号、分号与空白切分 |
| `normalizeRoguelikeAdvancedParams(advancedParams)` | 补齐缺失或为空的默认值；无变化时返回原引用，不修改入参 |
| `buildRoguelikeCommandParams(taskId, taskInputs, advancedParams)` | 主题代号在前，生效字段按字段表顺序追加 |
| `validateRoguelikeTaskInput(taskId, taskInputs, advancedParams)` | 两个已知模式必须有非空主题；生效下拉值必须属于当前主题候选表；刷坍缩范式模式还要求期望范式；未知任务交给调用方 |

命令拼接规则：

- 空字符串、未勾选的 checkbox、未设置的字段、当前主题/模式不适用的字段与不属于当前主题候选表的下拉值不写入命令；checkbox 为 true 时只追加参数名。
- 非 checkbox 字段追加 `参数名 值`；`list` 字段按切分后的每一项重复参数名（`--expected-collapsal-paradigms 目空一些 --expected-collapsal-paradigms 图像损坏`）。
- 声明 `defaultValue` 的字段在缺失或为空时解析为默认值并始终写入：生息演算 `-m` 因此始终出现，缺省为 `1`；开局职业组缺省 `稳扎稳打`，避免空缺时 Core 按固定位置点选职业组、与核心干员的职业不匹配。
- 未声明默认值的 select 不写命令：集成战略 `--mode` 继续省略，与 CLI 缺省 `0` 一致；界面显示由 `resolveRoguelikeAdvancedValue` 回落到当前主题的首项。
- 集成战略模式候选为 `0`（刷分）、`1`（刷源石锭）、`4`（刷开局）、`6`（刷月度小队）与 `7`（刷深入调查）；萨米额外提供 `5`（刷坍缩范式）。
- 字段的适用条件由字段表声明：`themes` 限定主题（如密文板只对萨米、指路鳞只对水月、种子只对萨卡兹刷源石锭），`modes` 限定模式（如凹直升只对刷开局、第五层前停止只对刷分、投资多刷分只对刷源石锭），`requires` 依赖另一字段（如非好友助战依赖使用助战、投资次数依赖未禁用投资；种子与凹开局密文板还通过 `oneOf` 限定分队）。
- 种子开局是文本参数：命令追加 `--start-with-seed <种子>`（例如 `2b3c4d,rogue_1,120`），不是无值开关；仅在萨卡兹刷源石锭模式且分队为点刺成锭或后勤时显示与下发。
- 凹开局密文板仅在萨米刷开局模式与生活至上分队下显示与下发；其他分队在开局奖励阶段不会获得密文板。
- 例：`taskInputs.roguelike = 'Sarkaz'`，高级值 `{ mode: '1', squad: '蓝图测绘分队', useSupport: true }` 生成
  `Sarkaz --mode 1 --squad 蓝图测绘分队 --roles 稳扎稳打 --use-support`；`taskInputs.reclamation = 'Tales'` 配合空高级值生成 `Tales -m 1`。
- 生息演算模式字段声明 `hint`，说明两种模式各自的存档与起始界面要求；面板只原样透传，文案归模型维护。
- 校验 trim 输入判断是否为空，不修改实际传给 CLI 的主题字符串。

面板只渲染 `isRoguelikeOptionVisible` 过滤后的字段：主题、模式与开关变化会同时改变字段集合、命令参数与“N 项”计数。草稿里保留的旧主题取值不删除，但下拉值必须属于当前主题的候选表：越界值在下拉项中标注“不适用于当前主题”，执行前校验会拒绝并提示重新选择，命令构造也不会写入；隐藏字段的残留值不参与校验与下发。

模型不读取配置通道或执行状态，因此可以用纯 Node 测试覆盖目录、参数顺序、可见性、空值过滤、默认值解析、归一化与校验。

### 4. Activity 与卸载

- `Activity` 隐藏会清理工作区与模式面板的 Effects（执行 hook 的确认计时器、`useFluidTabIndicator` 的 ResizeObserver/resize 监听），但保留 React state：当前模式、已加载草稿和面板输入不变。恢复时不会重新读取服务端配置（通道的 hydrated 守卫），也不会重放执行提交。
- 真正卸载/刷新会销毁 `activeMode` 与面板输入；配置草稿、pending 标记与在途提交仍属于应用级 `user-config` 通道，重新挂载后继续使用；运行身份由 `task-execution` 控制器持久化，页面重新订阅同一 run，不重新提交。
- 页面隐藏或 Activity 隐藏不改变后台 Run 的所有权；停止仍按控制器持有的 `runId` 执行。

### 5. 兼容与维护约束

- 配置 key、本地草稿、pending 与 wire 形状以[配置持久化协调器](../../architecture/config-persistence.md)为准；面板不另建持久化格式。
- 服务端端点、执行提交参数与幂等键语义未变化；停止仍走控制器 `stopTrackedRun()`。
- 保持渲染结构、DOM/CSS 类名与表单 `id`/`name`；字段键沿用迁移后的 camelCase，新增字段按含义插入相应分组，不改动已有键与表单名。
- 字段的默认值语义以命令模型为准：生息演算默认模式为 `1`，集成战略默认职业组为 `稳扎稳打`；两者都会写入 wire 与命令。
- 面板只组合命令模型、配置适配器与执行控制器；不在页面恢复独立的配置或执行状态。

## 回归与关联

### 回归测试

以下路径相对于 `client/src/`：领域回归在 `features/roguelike` 与 `pages/roguelike`；入口命令见[验证命令](#验证命令)。

关键不变量：

- 命令拼接：空值与未勾选项不写入，声明 `defaultValue` 的字段始终写入（生息演算 `-m 1`、集成战略 `--roles 稳扎稳打`），未声明默认值的 select 省略（集成战略 `--mode`），主题/模式不适用的字段与不属于当前主题候选表的下拉值不写入；列表字段逐项重复参数名。
- 可见性：主题专属字段随主题切换隐藏并停止下发，模式专属字段随模式切换隐藏；`requires` 未满足时隐藏（含开关缺省为关的情况）。
- 取值有效性：生效下拉值必须属于当前主题候选表，越界值在面板中标注且执行被拒绝；隐藏字段的残留值不影响校验。
- 校验：主题 trim 后非空；生效下拉值越界或刷坍缩范式模式缺少期望范式时拒绝提交，切换主题后模式重置为首项。
- 归一化不修改入参；`resolveRoguelikeAdvancedValue` 的首项回落只用于显示，不参与命令构造。
- 模式是局部状态：不进入配置 wire，跨模式草稿合并、空主题拒绝，Activity 隐藏保留而真正卸载回到 `roguelike`。
- 执行接线：按当前模式提交，停止/超时/失败/断线恢复由控制器 runId 持有，不重新提交。

### 验证命令

以下命令均在仓库根目录执行。

```sh
pnpm --filter la-pluma-next-client exec vitest run src/features/roguelike src/pages/roguelike
```

完整验证与视觉回归入口见[开发指南](../../development/README.md)。

### 关联契约

- [配置持久化协调器](../../architecture/config-persistence.md)
- [前端执行客户端与控制器](../../architecture/execution-client.md)
- [前端架构与所有权](../README.md)
