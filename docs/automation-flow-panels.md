# 自动化流程、定时与执行摘要面板

> [← 返回文档索引](README.md)

本文描述 FPR-039 交付的自动化流程列表、定时面板与执行摘要，以及承载它们的
工作区。配置草稿仍由 `automationConfig` 适配器与 `user-config` 协调器持有，
执行仍由 `task-execution` 控制器与服务端 Run 持有；本任务只做页面组合化、
局部交互状态归位和排序指针生命周期修复，不新增第二份配置、保存队列或运行
状态机。

相关契约：[自动化纯模型与排序](automation-model.md)、[自动化任务编辑面板](automation-editor.md)、
[配置持久化协调器](config-persistence.md)、[前端执行客户端与控制器](execution-client.md)、
[Query 缓存与键规范](query-cache.md)、[前端职责与质量基线](frontend-baseline.md)。

## 1. 定位与边界

| 内容 | 唯一归属 | 说明 |
| --- | --- | --- |
| 页头、全局状态指示与工作区组合 | `pages/AutomationTasks.tsx` | 只调用 `PageHeader`、`FloatingStatusIndicator` 与 `AutomationWorkspace` |
| 配置订阅、Run 订阅、选中项、撤销、连接测试、跨域失效、任务编辑 | `components/AutomationWorkspace.tsx` | 页面级领域容器；仍调用所属领域 hook，不直接调用 API/存储/轮询 |
| 流程列表、页脚与摘要组合 | `components/AutomationTaskFlowPanel.tsx` | 接收只读 Run 投影、排序投影与配置回调；页脚仍是任务挑选菜单的点击区域 |
| 定时编辑与通知 | `components/AutomationSchedulePanel.tsx` | 绑定 `model/automationSchedule.ts`；结果经 `onChange` 交给唯一配置 owner |
| 最近执行摘要 | `components/AutomationExecutionSummary.tsx` | 只接只读摘要与 run 身份；负责保留最后一份、展开/收起与失败自动展开 |
| 拖拽/键盘排序的 React 接线 | `hooks/useTaskFlowSorting.ts` | 预览、pointer 生命周期、Escape、公告；规则仍来自 `model/taskFlowSort.ts` |
| 当前活动展示 | `hooks/useAutomationActivity.ts` | 读取 `automation/activity` Query；失败只隐藏标签 |
| 逐项执行状态与摘要选择 | `model/flowExecution.ts` | 纯函数：活动期读 `progress`，空闲期回退流程终态摘要，单项状态/文案 |
| 配置提交、pending 与 schedule 完整单元 | `user-config` 协调器 + `automationConfig` 适配器 | 与 FPR-015 一致，未改 key、本地布局、wire 或完整提交条件 |
| 执行提交、观察、停止与旧断点 | `task-execution` 控制器 + `useAutomationExecution` | 面板只读快照；不发送停止以外的执行写操作 |

非目标与保持不变：

- 不改变配置 key、pending 键、`maa-task-flow`/`maa-schedule` 本地布局、wire 形状、
  `/agent/schedules/*`、通知端点和执行协议。
- 不改变任务参数默认值、智能养成参数、执行前校验顺序或执行身份。
- 不改变渲染结构与 DOM/CSS 类名；表单 `id`/`aria-label`、菜单 `id`/`role`、
  焦点顺序与键盘行为保持。没有新增样式，也没有更新视觉基线。
- 任务配置编辑器（通用参数字段、高级设置与连接测试）仍与工作区同文件组合；
  它读取同一草稿、选中项与执行投影，本任务不重排其表单结构。

## 2. 组合与状态边界

```
AutomationTasks（页头 + 全局指示）
└─ AutomationWorkspace（配置/执行/选中/撤销/连接/失效）
   ├─ AutomationTaskFlowPanel
   │  ├─ 任务流程列表（拖拽、启用、删除、撤销）
   │  ├─ automation-sequence-footer
   │  │  ├─ AutomationTaskPicker（页脚区域仍由本面板传入）
   │  │  └─ 立即执行 / 终止执行
   │  └─ AutomationExecutionSummary
   ├─ automation-task-editor（任务配置；同一草稿与执行投影）
   └─ automation-support-column
      ├─ ScreenMonitor
      └─ AutomationSchedulePanel（定时编辑 + NotificationSettings）
```

| 状态 | 所有者 | Activity 隐藏/恢复 | 真正卸载/刷新 |
| --- | --- | --- | --- |
| 配置草稿、pending 与提交队列 | `user-config` 协调器 | 保留；不重读已 hydrate 的草稿 | 应用级通道继续持有 |
| Run 身份、进度、终态摘要 | `task-execution` 控制器 + `useAutomationExecution` | 控制器继续观察；页面只重新订阅 | 按持久化身份恢复，不重提 |
| 选中任务、撤销快照、连接反馈 | `AutomationWorkspace` | 保留 | 重置 |
| 拖拽预览、当前拖拽索引、公告 | `useTaskFlowSorting` | 清理 document 监听并丢弃进行中的预览 | 重置 |
| 摘要保留与详情展开 | `AutomationExecutionSummary` | 保留；恢复时按当前摘要调整 | 重置 |
| 活动信息 | `automation/activity` Query | 观察者注销，恢复后按新鲜度重取 | 缓存按 `gcTime` 回收 |
| 菜单开关、外部点击、Escape 回焦 | `AutomationTaskPicker` | 保留；Effect 清理后恢复时重新注册 | 关闭 |

- **配置写入仍然单通道。** 流程、定时和任务编辑都调用工作区的
  `updateConfig`；面板不创建草稿副本，也不调用 `saveUserConfig`。
- **执行只读。** 流程列表与摘要只消费 `isRunning`/`isStopping`/`isSubmitting`/
  `taskResults`/`currentStep`/终态摘要；启动仍只由 `submitFlow` 发出一次
  `run_daily_flow`，停止仍按本页持有的 runId。
- **执行摘要不推断完成。** 步间延迟期间 run 仍活动；只有服务端终态摘要或
  `schedule.lastResult` 投影会进入“最近执行”。
- **页脚点击区域语义不变。** `AutomationTaskFlowPanel` 自己创建页脚 ref 并
  传给 `AutomationTaskPicker`；运行/停止按钮仍在页脚内，按下不会关闭菜单。

## 3. 流程列表与排序

`AutomationTaskFlowPanel` 只渲染 `tasks`（工作区传入的显示顺序）与
`execution`/`sorting` 投影。逐项状态与文案由 `model/flowExecution.ts` 计算：

| 规则 | 行为 |
| --- | --- |
| 未启用任务 | 始终 `idle`，显示任务描述而不是执行文案 |
| 有逐项结果 | 直接采用服务端状态；`running` 在 run 结束后显示为 `stopped` |
| 无结果且运行中 | 当前步骤 `running`，之前 `success`，之后 `pending` |
| 无结果且空闲 | `idle`；`pending` 文案回退为“未执行” |
| 当前步骤映射 | 优先 `currentTaskId`，否则按启用任务序号映射回流程索引 |
| 结果来源 | 活动期只读 `progress.taskResults`；提交在途清空；空闲期读终态摘要 |

排序规则仍由 `model/taskFlowSort.ts` 提供：10px 欧氏距离激活、按行中线计算
插入槽位、无效移动返回原引用、关闭游戏置底。React 接线由
`useTaskFlowSorting` 持有：

1. `pointerdown` 记录起点并尝试 `setPointerCapture`；
2. `pointermove` 超过阈值后进入预览，重排只更新本地 `dragFlow`；
3. `pointerup` 把最终顺序经 `onCommit` 交给工作区，由配置 owner 一次写入；
4. `Escape`、`pointercancel`、Activity 隐藏/卸载取消预览并恢复原顺序；
5. 方向键上/下与拖拽共用同一移动模型，提交后写入 `aria-live` 公告。

**指针生命周期修复。** 性能基线记录过重排后浏览器释放 pointer capture，
旧实现把 `lostpointercapture` 当成取消，导致真实拖拽没有保存。本任务把
`pointermove`/`pointerup`/`pointercancel` 挂到 `document`，排序不再依赖
capture 是否仍属于手柄；`lostpointercapture` 不再取消排序。capture 仍会
尽力建立，用于指针离开手柄时的浏览器语义。该行为由
`AutomationTasks.layout.test.tsx` 的“commits a pointer drag even when the
browser releases pointer capture”用例固定；DOM/CSS 未变化，成功排序的性能
复测仍归 FPR-043。

## 4. 定时编辑

`AutomationSchedulePanel` 直接调用 `model/automationSchedule.ts`，把结果作为
`{ enabled?, entries? }` 交给工作区的 `updateSchedule`；后者合并 `enabled`、
规范化 entries 并写入唯一配置草稿。规则与 FPR-037 一致：

| 操作 | 模型行为 | 面板失败路径 |
| --- | --- | --- |
| 新增时间点 | 从 12:00 起找第一个空闲整点；24 个整点占满返回 `null` | “没有可添加的执行时间” |
| 时/分编辑 | 取整并按 24/60 循环 | 非有限数值保留原时间部分 |
| 重复时间 | 返回 `duplicate` 且不修改 | “该执行时间已经存在” |
| 删除/启用 | 返回新数组；未知索引不产生可见变化 | 无 |
| 上限 | `MAX_SCHEDULE_ENTRIES = 6` 时隐藏“新增定时” | 无 |

执行期间开关、增删、步进与启用项全部禁用；禁用事实来自只读 Run 投影，
不是面板自己的运行状态。

## 5. 执行摘要

`AutomationExecutionSummary` 只接收工作区选好的 `displaySummary` 与 `runId`：

- 摘要为 `null`（例如新一次提交在途）时继续显示上一份；
- 相同 `runId` + 相同内容不重置用户手动收起的详情；
- 新 `runId` 到达时，即使内容相同，也按本次结果重新决定是否展开；
- 失败（`failedCount`/`errors`/失败动作/失败上报）自动展开详情；
- 阶段、掉落、上报、动作、错误与警告都直接来自服务端摘要，不推断成功。

`selectFlowDisplaySummary` 的优先级：本页持有 run 的终态摘要 → 空闲时
服务端流程投影 `schedule.lastResult` → 不展示。运行中或提交在途不展示旧摘要。

## 6. 当前活动读取

活动标签来自 `useAutomationActivity`：

- 使用 `automation/activity` Query（`clientType` 进入 key），与总览完整快照
  共用同一资源身份；
- 展示级读取显式 `retry: false`；失败只隐藏标签，不写全局状态、不阻塞配置
  或执行；
- 页面与面板不再直接调用 `getActivity`；Activity 隐藏时观察者注销，恢复后
  按 `staleTime` 决定是否后台重取；
- 活动名称缺失时回退显示活动 code。

## 7. Activity、兼容与回滚

- **Activity 隐藏/恢复**：流程排序的 document 监听随 Effect 清理并丢弃进行中
  的预览；摘要保留与展开状态保留；活动 Query 观察者注销；配置通道与执行
  控制器不受影响。
- **真正卸载/刷新**：选中、撤销、拖拽预览、摘要与连接反馈重置；配置草稿、
  pending 队列与 Run 身份仍由应用级所有者持有。
- 配置 key、本地存储键、wire 形状、调度与执行端点均未变化；旧草稿与服务端
  配置可直接读取。
- 渲染结构、DOM/CSS 类名与默认态视觉未变化；未新增样式，也未更新视觉基线。
- 唯一行为变化是 `lostpointercapture` 不再取消拖拽。它修复的是已记录缺陷，
  不改变默认态视觉；回归用例覆盖成功提交，取消路径仍由 Escape/`pointercancel`
  覆盖。
- 回滚本任务的提交可恢复页面内联实现；配置、执行与本地数据不需要迁移。

## 8. 回归证据

| 文件 | 覆盖 |
| --- | --- |
| `client/src/features/automation/model/flowExecution.test.ts` | 摘要来源优先级、活动/空闲/提交在途的逐项结果、当前步骤映射、单项状态与文案 |
| `client/src/features/automation/components/AutomationExecutionSummary.test.tsx` | 首次摘要前不渲染、提交在途保留上一份、失败自动展开、手动收起保持、新 run 重新展开、阶段/上报/警告详情 |
| `client/src/features/automation/pages/AutomationTasks.layout.test.tsx` | 活动 Query 展示、定时新增/上限/重复拒绝、拖拽在 lostpointercapture 后仍提交、Escape/pointercancel 取消、键盘排序、既有布局与编辑接线 |
| `client/src/features/automation/pages/AutomationTasks.config.test.tsx` | 配置与 schedule 完整提交、半失败重试、跨 remount 串行、迟到加载、Activity 恢复（Query Provider 包装） |
| `client/src/features/automation/pages/AutomationTasks.execution.test.tsx` | 单次 `run_daily_flow` 幂等提交、停止、流程进度、旧断点、摘要展示与 Activity 恢复（Query Provider 包装） |
| `client/src/features/automation/pages/AutomationTasks.activity.test.tsx` | 流程结束时 Activity 隐藏再恢复，完成标记不丢失、不停止、不重提 |
| `client/src/features/automation/model/taskFlowSort.test.ts`、`automationSchedule.test.ts` | 排序与定时规则本体（FPR-037 回归） |

针对性命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client exec vitest run src/features/automation
```

## 9. 剩余边界

- 通用任务配置编辑器仍在 `AutomationWorkspace` 内组合；本任务只迁出流程、定时
  与摘要，未改变其表单结构或参数规则。
- 成功拖拽的固定性能场景尚未补测；FPR-043 应以本任务的回归用例为行为前提
  重采拖拽数据。
- 活动 Query 的刷新策略沿用全局 `staleTime`/`gcTime` 与观察者语义，不额外
  轮询；活动周期切换的及时性以页面重新订阅或总览强制读取为准。

## 关联

- [自动化纯模型与排序](automation-model.md)：定时、命令、排序与掉落目标规则。
- [配置持久化协调器](config-persistence.md)：`automationConfig` 编解码、完整提交与重试边界。
- [前端执行客户端与控制器](execution-client.md)：提交、停止与 Run 身份。
- [Query 缓存与键规范](query-cache.md)：活动资源键与默认读取策略。
- [前端职责与质量基线](frontend-baseline.md)：Automation 页职责与视觉复现入口。
