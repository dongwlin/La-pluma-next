# 自动化任务编辑面板

> [← 返回文档索引](README.md)

本文描述 FPR-038 交付的自动化任务编辑与挑选组件、它们的局部交互状态和纯模型边界。配置草稿仍由 `automationConfig` 适配器与 `user-config` 协调器持有，执行仍由 `task-execution` 控制器与服务端 Run 持有；本任务只把 `StageEditor`/`TaskPicker` 从页面迁出，并下沉菜单开关、外部点击、Escape 回焦与智能养成在途标记，不新增第二份配置、保存队列或执行状态。

相关契约：[自动化纯模型与排序](automation-model.md)、[配置持久化协调器](config-persistence.md)、[前端执行客户端与控制器](execution-client.md)、[前端职责与质量基线](frontend-baseline.md)。

## 1. 定位与边界

| 内容 | 唯一归属 | 说明 |
| --- | --- | --- |
| 页面组合、配置订阅、执行订阅、选中项、撤销、连接测试 | `pages/AutomationTasks.tsx` + `components/AutomationWorkspace.tsx` | FPR-039 后页面只组合工作区；流程/定时/摘要分别在独立面板 |
| 流程列表、拖拽排序、页脚与执行摘要 | `components/AutomationTaskFlowPanel.tsx` + `hooks/useTaskFlowSorting.ts` | 只接只读 Run 投影；排序预览与编辑器共享 |
| 定时编辑与通知 | `components/AutomationSchedulePanel.tsx` | 绑定定时纯模型，经工作区唯一配置 owner 写入 |
| 关卡列表编辑、次数步进、置顶、增删行 | `components/AutomationStageEditor.tsx` | 受控面板：参数经 `onUpdate(index, 'stages', value)` 写回工作区 |
| 智能养成加入/移除与在途标记 | `components/AutomationStageEditor.tsx` + `model/stageEditing.ts` | 读取 `training-queue`、调用 `generateTrainingPlan({ mode: 'current' })`；合成规则在纯模型 |
| 任务挑选菜单 | `components/AutomationTaskPicker.tsx` | 菜单开关、外部 pointerdown、Escape 回焦与运行态收起都在面板内 |
| 可添加任务目录 | `components/automationTaskCatalog.tsx` | 名称、图标、默认参数与参数字段；不读取配置/Query/执行状态 |
| 关卡分组与智能养成合成 | `model/stageEditing.ts` | 纯模型；`orderStagesForEditing` 也复用同一分组 |
| 公招招募时长校验 | `model/taskParamRules.ts` | 纯模型：10 分钟取整、60–540 夹取、非法输入回退 |
| 配置提交、pending 与 schedule 完整单元 | `user-config` 协调器 + `automationConfig` 适配器 | 面板不调用 `saveUserConfig`、不写 localStorage、不拥有提交队列 |

非目标与保持不变：

- 不改变配置 key、pending 键、`maa-task-flow`/`maa-schedule` 本地布局、wire 形状或 `/agent/schedules/*` 端点。
- 不改变任务参数默认值、智能养成计划生成参数、执行前校验顺序或执行身份。
- 不改变渲染结构与 DOM/CSS 类名：原 JSX 原样迁出，表单 `id`/`aria-label`、菜单 `id`/`role`、焦点顺序与键盘行为不变；没有新增 CSS，也没有更新视觉基线。
- 挑选面板仍把“整条流程页脚”作为点击区域：在页脚内按下指针（包括运行/停止按钮）不关闭菜单，页脚之外按下才关闭，与迁移前一致。

## 2. 组合与状态边界

```
AutomationTasks（页头 + 全局指示）
└─ AutomationWorkspace（配置/执行/选中/撤销/连接/失效）
   ├─ AutomationTaskFlowPanel
   │  ├─ 任务流程列表（拖拽预览、拖拽公告）
   │  └─ automation-sequence-footer
   │     ├─ AutomationTaskPicker（open / 外部点击 / Escape / disabled 收起）
   │     ├─ 立即执行 / 终止执行（工作区回调）
   │     └─ …
   └─ automation-task-editor
      └─ AutomationStageEditor（isSmartStageLoading / 关卡写回）
```

| 状态 | 所有者 | Activity 隐藏/恢复 | 真正卸载/刷新 |
| --- | --- | --- | --- |
| 配置草稿、pending 与提交队列 | `user-config` 协调器 | 保留；不重读已 hydrate 的草稿 | 应用级通道继续持有 |
| 关卡列表 | 配置草稿 `task.params.stages` | 保留 | 随草稿恢复 |
| 智能养成在途标记 | `AutomationStageEditor` | 保留；在途 promise 不受 Effect 清理取消，`finally` 继续清标记 | 重置 |
| 菜单开关 | `AutomationTaskPicker` | 保留；Effect 清理时注销 document 监听，恢复后重新注册 | 重置为关闭 |
| 选中任务、撤销、连接反馈 | `AutomationWorkspace` | 保留 | 重置 |
| 拖拽预览、公告 | `useTaskFlowSorting` | 清理 document 监听并丢弃进行中的预览 | 重置 |
| 执行详情 | `AutomationExecutionSummary` | 保留 | 重置 |

- **参数写回仍然单通道。** 面板只调用 `onUpdate`，经工作区转交 `useUserConfig` 的 `update`；面板内不创建草稿副本。
- **智能养成只写一次。** 读取队列与生成计划是领域能力调用；成功后把生成的关卡与现有置顶/普通关卡合成一次写回。
- **菜单是纯局部状态。** 工作区只在添加成功后选中新任务；是否关闭菜单由面板自己决定。

## 3. 关卡编辑与智能养成

`model/stageEditing.ts` 的输入是 `Array<string | StageConfig>`（旧草稿允许只有关卡名），输出是新数组或原数组引用：

| 规则 | 行为 |
| --- | --- |
| 默认列表 | 草稿缺失时返回新的空白行；显式空数组保持为空，由“添加关卡”继续输入 |
| 分组 | `splitStagesForEditing` 输出 置顶 → 智能养成 → 普通 → 空白；`flattenStagesForEditing` 按同序拼接；同时带 `pinned` 与 `smart` 的异常形状只归入置顶 |
| 统计 | `countConfiguredStages` 只数有关卡名的行；`findTrainingOperators` 取最后一个带干员信息的智能关卡 |
| 置顶 | 字符串行升级为 `{ stage, times: '', pinned: true }`；对象行切换 `pinned`；智能关卡与缺失索引返回原引用 |
| 改名/次数 | 字符串行升级为对象形状；缺失索引返回原引用 |
| 次数步进 | 从 `Number(times) || 0` 起算，最低 0；智能关卡不参与 |
| 删除 | 删空后保留一个空白行 |
| 智能养成移除 | 保留置顶与普通关卡（空白行随之丢弃），没有剩余行时回退空白行 |
| 智能养成插入 | 置顶之后、普通关卡之前插入生成项，再交给 `updateTaskFlowParams` 的 `orderStagesForEditing` 统一顺序 |
| 生成项 | 沿用计划的 `stage` 与 `totalTimes`，写 `smart: true` 与本次计划的干员名列表 |

`AutomationStageEditor` 的 `updateStages` 只在模型返回新数组时调用 `onUpdate`；无效索引与智能关卡的不可达编辑不会产生配置写入。智能养成失败路径保持原文案与顺序：

- 养成队列为空/读取失败 → “智能养成队列为空，请先添加干员”；
- 生成计划失败 → “生成刷取计划失败”；
- 计划没有关卡 → “当前干员材料已集齐！”且不写回；
- 抛错 → “操作失败: …”；`finally` 始终清除在途标记。

公招招募时长的失焦归一化由 `model/taskParamRules.ts` 的 `normalizeRecruitmentTime` 完成：`Math.round(value / 10) * 10` 后夹取到 60–540；非有限输入回退 540。页面仍使用同一输入框的 `min`/`max`/`step` 属性。

## 4. 挑选面板的焦点与键盘

| 交互 | 行为 |
| --- | --- |
| 触发器 | `aria-haspopup="menu"`、`aria-expanded`、`aria-controls="automation-task-picker"`；菜单打开时追加 `is-open` |
| 菜单 | `role="menu"`、`aria-label="可添加任务"`，每项 `role="menuitem"` |
| 选择 | 调用页面 `onAddTask` 后关闭菜单；页面负责加入流程并选中新任务 |
| Escape | 关闭菜单并把焦点还给触发器 |
| 外部按下 | 指针落在页面传入的页脚区域之外时关闭；区域之内（含运行/停止按钮）不关闭 |
| 运行态 | `disabled` 变为 true 时收起菜单并禁用触发器；组件挂载时若已禁用则保持关闭 |
| 计数 | 菜单项显示当前流程中同 `commandId` 的数量（含拖拽预览顺序） |

面板不实现焦点陷阱；菜单项的 Tab 顺序与迁移前一致。

## 5. Activity、兼容与回滚

- **Activity 隐藏/恢复**：面板 state 保留；document 监听在 Effect 清理时注销，恢复后按当前 `open` 重新注册，不会遗留监听。智能养成在途 promise 继续完成，隐藏期间只更新自身状态，不写配置以外的资源。流程排序的 document 监听同样在 Activity 隐藏时清理并丢弃进行中的预览。
- **真正卸载/刷新**：菜单回到关闭，在途标记重置；配置草稿、pending 队列与 Run 身份仍由应用级所有者持有。
- 配置 key、本地存储键、迁移与 wire 形状未变化；旧草稿可直接读取。
- 渲染结构、DOM/CSS 类名、表单 `id`/`aria-label` 与默认态视觉未变化，未新增样式，也未更新任何视觉基线。
- 回滚本任务的提交可恢复页面内联组件；配置、执行与本地数据不需要迁移。

## 6. 回归证据

| 文件 | 覆盖 |
| --- | --- |
| `client/src/features/automation/model/stageEditing.test.ts` | 默认/空列表、分组一次归类与多重集合、置顶/改名/次数/步进/删除、智能养成增删与生成项、干员摘要、不可达索引原引用 |
| `client/src/features/automation/model/taskParamRules.test.ts` | 10 分钟取整、60–540 夹取、空串/非有限输入回退 |
| `client/src/features/automation/components/AutomationStageEditor.test.tsx` | 智能养成插入顺序、空队列/计划失败/抛错/材料已齐失败路径、移除保留置顶与普通行、步进与置顶写回、运行态禁用 |
| `client/src/features/automation/components/AutomationTaskPicker.test.tsx` | 目录渲染与计数、选择回调后关闭、页脚内按下不关闭/外部关闭、Escape 回焦、禁用收起 |
| `client/src/pages/automation/AutomationTasks.layout.test.tsx` | 既有布局、表单标签、picker 菜单/焦点/Activity 恢复后的 Escape 关闭、智能养成页面接线、公招时长失焦归一化、FPR-039 的拖拽/定时/摘要接线 |
| `client/src/pages/automation/AutomationTasks.{config,execution,activity}.test.tsx` | 既有配置持久化、执行身份与 Activity 回归（FPR-039 起以 Query Provider 包装活动读取） |

针对性命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client exec vitest run src/features/automation
```

## 关联

- [自动化流程、定时与执行摘要面板](automation-flow-panels.md)：页面/工作区/流程/定时/摘要的组合与排序指针生命周期。
- [自动化纯模型与排序](automation-model.md)：定时时间、流程命令、排序与掉落目标规则。
- [配置持久化协调器](config-persistence.md)：`automationConfig` 编解码、完整提交与重试边界。
- [前端执行客户端与控制器](execution-client.md)：提交、停止与 Run 身份。
- [前端职责与质量基线](frontend-baseline.md)：Automation 页职责与视觉复现入口。
