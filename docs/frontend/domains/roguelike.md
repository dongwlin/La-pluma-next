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
| 高级字段与运行/停止按钮 | `features/roguelike/components/RoguelikeSettingsPanel.tsx` | 只渲染选项表并调用注入的执行动作，不创建执行状态机 |
| 配置 key、本地草稿、pending 与 300ms 提交 | `features/roguelike/model/roguelikeConfig.ts` + `features/user-config` | 配置适配器维持 key、本地键和 wire 协议 |
| 任务目录、主题快捷项、高级选项与默认值、命令拼接、草稿归一化与输入校验 | `features/roguelike/model/roguelikeTasks.ts` | 纯模型，不访问 React、Query、配置通道或网络 |
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
   └─ aside（ScreenMonitor 预览）
```

- **当前模式**是跨面板的局部交互状态：它决定主题与高级字段面板展示哪一份 `taskInputs`/`advancedParams`。它不进入配置 wire；`Activity` 隐藏/恢复保留，真正卸载或刷新后回到默认的 `roguelike`。
- **配置草稿**只由工作区的一次 `useUserConfig(roguelikeConfigAdapter)` 读取。主题与高级字段编辑分别合并当前 `taskInputs`/`advancedParams` 后交给同一个通道；页面、面板都不直接调用 `saveUserConfig`/`loadUserConfig` 或写 `localStorage`。
- **同步反馈**由工作区从通道的 `error`/`syncState` 派生：失败时显示页内 `role="alert"` 与“重新同步”，`syncState === 'saving'` 期间按钮显示“同步中”；只有手动 `retry()` 返回 true 才提示“肉鸽配置已同步”。
- **执行**只由工作区的一次 `useRoguelikeExecution` 订阅。设置面板拿到的是 `isRunning`/`isStopping`/`isSubmitting` 与 `onExecute`/`onStop` 投影；停止确认、终态提示和 run 身份仍由 hook/控制器持有，面板没有第二份状态机。
- 模式面板只保存 `useFluidTabIndicator` 的容器 ref、高亮矩形与键盘处理；这些测量状态不参与配置或执行。

### 3. 纯命令模型

`features/roguelike/model/roguelikeTasks.ts` 从页面移出以下规则：

| 导出 | 作用 |
| --- | --- |
| `ROGUELIKE_TASKS` | 集成战略/生息演算的任务名、命令、图标、占位与描述 |
| `ROGUELIKE_THEME_PRESETS` | 各模式的主题快捷项；只影响界面，不进入 wire |
| `DEFAULT_RECLAMATION_MODE` | 生息演算默认模式 `'1'`，与 CLI 的 `-m` 缺省一致 |
| `getRoguelikeAdvancedOptions(taskId)` | 高级字段表及其 CLI 参数名，含可选的 `defaultValue` 与 `hint`；未知任务返回空表 |
| `resolveRoguelikeAdvancedValue(option, advanced)` | 字段显示值：显式值优先，其次默认值，select 最后回落到首项 |
| `normalizeRoguelikeAdvancedParams(advancedParams)` | 补齐缺失或为空的默认值；无变化时返回原引用，不修改入参 |
| `buildRoguelikeCommandParams(taskId, taskInputs, advancedParams)` | 主题代号在前，高级参数按选项表顺序追加 |
| `validateRoguelikeTaskInput(taskId, taskInputs)` | 两个已知模式必须有非空主题；未知任务交给调用方 |

命令拼接规则：

- 空字符串、未勾选的 checkbox 与未设置的字段不写入命令；checkbox 为 true 时只追加参数名。
- 非 checkbox 字段追加 `参数名 值`。声明 `defaultValue` 的字段在缺失或为空时解析为默认值并始终写入：生息演算 `-m` 因此始终出现，缺省为 `1`。
- 未声明默认值的 select 不写命令：集成战略 `--mode` 继续省略，与 CLI 缺省 `0` 一致；界面显示由 `resolveRoguelikeAdvancedValue` 回落到首项。
- 例：`taskInputs.roguelike = 'Phantom'`，高级值 `{ mode: '1', squad: '指挥分队', useSupport: true }` 生成
  `Phantom --mode 1 --squad 指挥分队 --use-support`；`taskInputs.reclamation = 'Tales'` 配合空高级值生成 `Tales -m 1`。
- 生息演算模式字段声明 `hint`，说明两种模式各自的存档与起始界面要求；面板只原样透传，文案归模型维护。
- 校验只 trim 输入判断是否为空，不修改实际传给 CLI 的主题字符串。

模型不读取配置通道或执行状态，因此可以用纯 Node 测试覆盖目录、参数顺序、空值过滤、默认值解析、归一化与校验。

### 4. Activity 与卸载

- `Activity` 隐藏会清理工作区与模式面板的 Effects（执行 hook 的确认计时器、`useFluidTabIndicator` 的 ResizeObserver/resize 监听），但保留 React state：当前模式、已加载草稿和面板输入不变。恢复时不会重新读取服务端配置（通道的 hydrated 守卫），也不会重放执行提交。
- 真正卸载/刷新会销毁 `activeMode` 与面板输入；配置草稿、pending 标记与在途提交仍属于应用级 `user-config` 通道，重新挂载后继续使用；运行身份由 `task-execution` 控制器持久化，页面重新订阅同一 run，不重新提交。
- 页面隐藏或 Activity 隐藏不改变后台 Run 的所有权；停止仍按控制器持有的 `runId` 执行。

### 5. 兼容与维护约束

- 配置 key、本地草稿、pending 与 wire 形状以[配置持久化协调器](../../architecture/config-persistence.md)为准；面板不另建持久化格式。
- 服务端端点、执行提交参数与幂等键语义未变化；停止仍走控制器 `stopTrackedRun()`。
- 保持渲染结构、DOM/CSS 类名与表单 `id`/`name`；这里的“默认态视觉”指样式与布局，字段的默认值语义以命令模型为准（生息演算默认模式为 `1`）。
- 面板只组合命令模型、配置适配器与执行控制器；不在页面恢复独立的配置或执行状态。

## 回归与关联

### 回归测试

| 文件 | 覆盖 |
| --- | --- |
| `client/src/features/roguelike/model/roguelikeTasks.test.ts` | 任务目录、主题快捷项、高级选项表、生息演算默认模式与说明、命令顺序、空值过滤、默认值解析、显式 `-m`、归一化、输入不变性与校验 |
| `client/src/features/roguelike/model/roguelikeConfig.test.ts` | 配置适配器原有回归（key、本地键、wire、载荷校验、提交与读取失败），以及生息演算默认模式在编码、解码与本地读写中的补齐 |
| `client/src/pages/roguelike/RoguelikeTasks.test.tsx` | 模式键盘导航与标签关联、模式切换、高级字段进入命令、按当前模式提交、空配置与旧配置的显示/提交一致、模式说明的可访问性、空主题拒绝、跨模式草稿合并、Activity 隐藏/恢复与 remount 的模式生命期、配置 pending/重试/迟到加载、执行提交/停止/超时/失败/断线恢复 |

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
