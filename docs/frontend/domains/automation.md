# 自动化

> [← 返回前端架构](../README.md) · [文档索引](../../README.md)

本文集中维护本领域的面板、模型与命令约定；通用契约通过链接引用。

- [页面、流程与执行摘要](#页面流程与执行摘要)
- [纯模型与排序](#纯模型与排序)
- [任务编辑](#任务编辑)
- [回归与关联](#回归与关联)

## 页面、流程与执行摘要

配置草稿仍由 `automationConfig` 适配器与 `user-config` 协调器持有，
执行仍由 `task-execution` 控制器与服务端 Run 持有；工作区负责
局部交互状态与排序指针生命周期，不新增第二份配置、保存队列或运行
状态机。

### 1. 定位与边界

| 内容 | 唯一归属 | 说明 |
| --- | --- | --- |
| 页头、全局状态指示与工作区组合 | `pages/automation/AutomationTasks.tsx` | 只调用 `PageHeader`、`FloatingStatusIndicator` 与 `AutomationWorkspace` |
| 配置订阅、Run 订阅、选中项、撤销、连接测试、跨域失效、任务编辑 | `components/AutomationWorkspace.tsx` | 页面级领域容器；仍调用所属领域 hook，不直接调用 API/存储/轮询 |
| 流程列表、页脚与摘要组合 | `components/AutomationTaskFlowPanel.tsx` | 接收只读 Run 投影、排序投影与配置回调；页脚仍是任务挑选菜单的点击区域 |
| 定时编辑与通知 | `components/AutomationSchedulePanel.tsx` | 绑定 `model/automationSchedule.ts`；结果经 `onChange` 交给唯一配置 owner |
| 最近执行摘要 | `components/AutomationExecutionSummary.tsx` | 只接只读摘要与 run 身份；负责保留最后一份、展开/收起与失败自动展开 |
| 拖拽/键盘排序的 React 接线 | `hooks/useTaskFlowSorting.ts` | 预览、pointer 生命周期、Escape、公告；规则仍来自 `model/taskFlowSort.ts` |
| 当前活动展示 | `hooks/useAutomationActivity.ts` | 读取 `automation/activity` Query；失败只隐藏标签 |
| 逐项执行状态与摘要选择 | `model/flowExecution.ts` | 纯函数：活动期读 `progress`，空闲期回退流程终态摘要，单项状态/文案 |
| 配置提交、pending 与 schedule 完整单元 | `user-config` 协调器 + `automationConfig` 适配器 | 遵循配置协调器契约，维持 key、本地布局、wire 与完整提交条件 |
| 执行提交、观察、停止与旧断点 | `task-execution` 控制器 + `useAutomationExecution` | 面板只读快照；不发送停止以外的执行写操作 |

维护约束：

- 配置 key、pending、本地布局与 wire 形状以[配置持久化协调器](../../architecture/config-persistence.md)
  为准；保持 `/agent/schedules/*`、通知端点和执行协议兼容。
- 不改变任务参数默认值、智能养成参数、执行前校验顺序或执行身份。
- 遵循既有渲染结构与 DOM/CSS 类名；表单 `id`/`aria-label`、菜单 `id`/`role`、
  焦点顺序与键盘行为保持。没有新增样式，也没有更新视觉基线。
- 任务配置编辑器（通用参数字段、高级设置与连接测试）仍与工作区同文件组合；
  它读取同一草稿、选中项与执行投影，表单结构与参数规则保持不变。

### 2. 组合与状态边界

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

### 3. 流程列表与排序

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
不能把 `lostpointercapture` 当成取消，否则会导致真实拖拽没有保存。当前实现把
`pointermove`/`pointerup`/`pointercancel` 挂到 `document`，排序不再依赖
capture 是否仍属于手柄；`lostpointercapture` 不再取消排序。capture 仍会
尽力建立，用于指针离开手柄时的浏览器语义。该行为由
`AutomationTasks.layout.test.tsx` 的“commits a pointer drag even when the
browser releases pointer capture”用例固定；DOM/CSS 未变化。性能复测采用[性能采样工具](../../../client/tests/performance/README.md)中的相同场景与完成条件。

### 4. 定时编辑

`AutomationSchedulePanel` 直接调用 `model/automationSchedule.ts`，把结果作为
`{ enabled?, entries? }` 交给工作区的 `updateSchedule`；后者合并 `enabled`、
规范化 entries 并写入唯一配置草稿。规则如下：

| 操作 | 模型行为 | 面板失败路径 |
| --- | --- | --- |
| 新增时间点 | 从 12:00 起找第一个空闲整点；24 个整点占满返回 `null` | “没有可添加的执行时间” |
| 时/分编辑 | 取整并按 24/60 循环 | 非有限数值保留原时间部分 |
| 重复时间 | 返回 `duplicate` 且不修改 | “该执行时间已经存在” |
| 删除/启用 | 返回新数组；未知索引不产生可见变化 | 无 |
| 上限 | `MAX_SCHEDULE_ENTRIES = 6` 时隐藏“新增定时” | 无 |

执行期间开关、增删、步进与启用项全部禁用；禁用事实来自只读 Run 投影，
不是面板自己的运行状态。

执行时间按连接 profile 的客户端服务区时区注册 cron（国服与繁中为
`Asia/Shanghai`，其它服使用各自时区），非国服触发的绝对时刻会与浏览器本地时间
不同；面板说明同时标注“每日 04:00 刷新游戏日”。`/agent/schedules` 的请求与
响应形状不变，时区只进入注册日志与诊断投影。

### 5. 执行摘要

`AutomationExecutionSummary` 只接收工作区选好的 `displaySummary` 与 `runId`：

- 摘要为 `null`（例如新一次提交在途）时继续显示上一份；
- 相同 `runId` + 相同内容不重置用户手动收起的详情；
- 新 `runId` 到达时，即使内容相同，也按本次结果重新决定是否展开；
- 失败（`failedCount`/`errors`/失败动作/失败上报）自动展开详情；
- 阶段、掉落、上报、动作、错误与警告都直接来自服务端摘要，不推断成功。

`selectFlowDisplaySummary` 的优先级：本页持有 run 的终态摘要 → 空闲时
服务端流程投影 `schedule.lastResult` → 不展示。运行中或提交在途不展示旧摘要。

### 6. 当前活动读取

活动标签来自 `useAutomationActivity`：

- 使用 `automation/activity` Query（`clientType` 进入 key），与总览完整快照
  共用同一资源身份；
- 展示级读取显式 `retry: false`；失败只隐藏标签，不写全局状态、不阻塞配置
  或执行；
- 页面与面板不再直接调用 `getActivity`；Activity 隐藏时观察者注销，恢复后
  按 `staleTime` 决定是否后台重取；
- 活动名称缺失时回退显示活动 code。

### 7. Activity 与兼容约束

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

### 剩余边界

- 通用任务配置编辑器仍在 `AutomationWorkspace` 内组合；流程、定时
  与摘要在各自面板中，未改变其表单结构或参数规则。
- 指针排序的性能比较必须先验证保存完成条件；旧版取消结果不可直接与成功保存耗时比较。采样方法见[性能采样工具](../../../client/tests/performance/README.md)。
- 活动 Query 的刷新策略沿用全局 `staleTime`/`gcTime` 与观察者语义，不额外
  轮询；活动周期切换的及时性以页面重新订阅或总览强制读取为准。

## 纯模型与排序

配置提交仍由 [`automationConfig.ts`](../../../client/src/features/automation/model/automationConfig.ts) 适配器与 `user-config` 协调器持有，执行仍由 `task-execution` 控制器与服务端 Run 持有；当前指针/键盘接线由 `hooks/useTaskFlowSorting.ts` 持有，逐项执行状态与摘要来源由 `model/flowExecution.ts` 提供，模型本身仍不访问 React、网络或存储。

### 1. 定位与边界

| 模块 | 输入 | 输出 | 面板/工作区调用点 |
| --- | --- | --- | --- |
| `model/automationSchedule.ts` | 本地 `schedule.entries`、一次时间编辑 | 新的 entries 或 `{ ok: false, reason }` | 开关、增删时间点、时/分编辑与候选时间 |
| `model/taskFlowCommands.ts` | 当前草稿 flow、任务定义、参数键值 | 新 flow、新任务、校验失败项 | 添加、删除、恢复、启用、参数编辑、执行前校验 |
| `model/taskFlowSort.ts` | 指针坐标、流程与中线读取器 | 目标索引、重排后的 flow | `hooks/useTaskFlowSorting.ts` 的拖拽与键盘上下移动 |
| `model/flowExecution.ts` | 活动进度、终态摘要、流程 | 逐项状态/文案与“最近执行”来源 | 流程面板、任务编辑与执行摘要 |
| `model/dropTargets.ts` | `fight.params.drops` 的任意历史形状 | 结构化目标或 `null` | 由命令模型执行前校验调用 |

维护约束：

- 不改变 `/agent/schedules`、`/agent/schedules/manual/execute` 等端点、配置 key、本地存储键或 wire 形状。
- 不改变任务执行引擎、旧断点续跑、执行控制器身份或 Activity 语义。
- 纯模型不负责渲染，DOM/CSS 类名、表单 `id`/`aria-label` 和默认态视觉由现有面板保持。
- `automationConfig.ts` 仍是持久化适配器的唯一入口；它从两个纯模型导入时间与排序规则，而不是反向依赖网络或 React。

### 2. 定时时间规则

| 规则 | 行为 |
| --- | --- |
| 解析 | `parseScheduleTime` 把 `HH:mm` 拆成时/分，非法文本回退 `00:00`，越界值夹取到 `23:59` |
| 格式化 | `formatScheduleTime` 始终补零为两位时/分 |
| 规范化 | `normalizeScheduleEntries` 丢弃非法与重复时间点，`enabled` 缺省视为 `true`；同名工具 `normalizeScheduleTimes` 处理 wire 的 `times` |
| 旧格式 | `scheduleEntriesFromTimes` 把旧 `times` 转成全启用 entries；`activeScheduleTimes` 只导出启用项，禁用行只保留在本地 `maa-schedule.entries` |
| 默认值 | `createDefaultScheduleEntries` 每次返回新的 `08:00/14:00/20:00` 行，避免草稿共享可变对象 |
| 新增 | `findNextScheduleTime` 从 12:00 起逐小时扫描，返回第一个未被占用的整点；`appendScheduleEntry` 追加启用行，24 个整点都占用时返回 `null` |
| 编辑 | `updateScheduleTimeEntry` 对数值取整，并按 24/60 循环时/分；与其它行重复返回 `duplicate` 且不修改草稿；索引缺失返回 `missing`；非有限数值保留原时间部分 |
| 上限 | `MAX_SCHEDULE_ENTRIES = 6`，定时面板据此隐藏“新增定时”按钮，模型本身不裁剪已有行 |
| 旧页面文案 | `没有可添加的执行时间` 与 `该执行时间已经存在` 仍由面板根据模型结果展示，模型不保存 UI 文案 |

编辑结果交给 `AutomationSchedulePanel` 的 `onChange`，由工作区的 `updateSchedule` 合并 `enabled`/`entries` 并调用 `normalizeScheduleEntries` 后写入唯一配置草稿。

### 3. 任务流程命令规则

| 规则 | 行为 |
| --- | --- |
| 命令身份 | `resolveTaskCommandId` 优先 `commandId`，缺失时回退 `${commandId}-${时间戳}` 的 id 前缀；执行校验使用该结果 |
| 添加任务 | `addTaskToFlow` 复制定义中的 `defaultParams` 生成新 `params`，id 为 `${commandId}-${now}`；`icon`/`paramFields` 被剥离，其余字段（含 `defaultParams`）保持迁移前的持久化形状 |
| 关闭游戏 | 新关闭游戏任务继承启动游戏的 `clientType`（缺省 `Official`），并始终追加到流程末尾；添加其它任务会重新经过 `placeClosedownLast` |
| 恢复删除 | `insertTaskFlowItem` 按删除时索引插入，越界索引夹取到 `[0, flow.length]`，再保证关闭游戏在最后 |
| 删除/启用 | `removeTaskFlowItem`、`toggleTaskFlowItemEnabled` 返回新数组；未知索引不产生可见变化 |
| 参数编辑 | `updateTaskFlowParams` 只替换目标任务；`clientType` 变化时同步启动/关闭游戏步骤，与迁移前一致 |
| 关卡分组 | `splitStagesForEditing` 负责 置顶/智能养成/普通/空白 分类，`orderStagesForEditing` 按 置顶 → 智能养成 → 普通 → 空白输入行拼接；任务编辑面板的智能养成增删复用同一分类。组内保持原顺序，每个条目只归类一次，长度与多重集合不变 |
| 执行前校验 | `findTaskFlowValidationFailure` 先检查启用中的自定义换班（`taskType === 'Infrast'`、`mode === 10000`、`filename` 为空），再检查启用中的 `fight` 掉落目标；返回第一个无效任务 id 与提示 |
| 提示文案 | 两条校验文案由模型返回，工作区负责写入全局状态消息并选中该任务 |

同时带 `pinned` 与 `smart` 的异常关卡形状按置顶归类一次；旧页面会把它复制到两个分组。正常编辑路径不会产生该形状。

### 4. 排序规则与不变量

| 规则 | 行为 |
| --- | --- |
| 拖拽阈值 | `hasPointerSortActivated` 使用欧氏距离，位移 `>= 10px` 才激活；常量 `POINTER_SORT_ACTIVATION_PX` 为 10 |
| 目标索引 | `getPointerSortTargetIndex` 先移除被拖拽项，再按其余任务中线计算插入槽位；无法读取中线的任务被跳过；被拖拽项不在流程中返回 `-1` |
| 重排 | `moveTaskFlowItem` 对同位置、越界或缺失源项返回原数组引用；合法移动返回新数组，长度为 `[0, length)` 的目标索引直接配合拖拽槽位 |
| 不变量 | 每次合法移动都保持长度与成员多重集合；移动后再移回恢复原顺序；键盘上下移动与拖拽共用同一函数 |
| 关闭游戏 | `placeClosedownLast` 把 `commandId === 'closedown'` 或 id 以 `closedown-` 开头的任务稳定地移到末尾，其余任务保持相对顺序 |
| 引用判定 | 排序 hook 用 `newFlow === currentFlow` 判断键盘移动是否需要提交，因此无效移动必须返回原引用 |

`automationConfig.ts` 的载荷解码也调用同一个 `placeClosedownLast`，持久化顺序与页面编辑顺序不会分叉。

### 5. 掉落目标格式

`fight.params.drops` 支持两种历史形状：

- 文本：`30011=10,30062=5`，条目两端允许空白，`=` 两侧允许空白；
- 旧对象：`{ "30011": 10, "30062": "5" }`。

规则：

- 物品 ID 只允许字母、数字、`_`、`-`；数量必须是正整数，`0`、负数、小数与非数字都使整份输入无效；
- 任一条目非法时 `parseDropTargets` 返回 `null`，执行前校验据此阻止提交；
- 空值（`undefined`/`null`/`''`）解析为空数组，表示未设置目标；
- 重复条目保留原顺序，不做去重，兼容旧草稿；
- `formatDropTargets` 输出无空格的规范文本，与 `parseDropTargets` 互为逆变换。

### 6. 兼容与视觉约束

- 配置 key、pending、本地布局与 wire 形状以[配置持久化协调器](../../architecture/config-persistence.md)为准；本域纯模型保留 `entries`/`times` 兼容读取。
- 新任务仍携带 `defaultParams` 且不含 `icon`/`paramFields`；模型输出已由 `automationConfigAdapter.decodeDraft` 的回归用例验证可被现有迁移接受。
- 面板 DOM/CSS、表单 id、`aria-label`、拖拽手柄与键盘行为不变；没有新增 CSS，也没有更新视觉基线。

## 任务编辑

配置草稿仍由 `automationConfig` 适配器与 `user-config` 协调器持有，执行仍由 `task-execution` 控制器与服务端 Run 持有；这些面板持有菜单开关、外部点击、Escape 回焦与智能养成在途标记，不新增第二份配置、保存队列或执行状态。

### 1. 定位与边界

| 内容 | 唯一归属 | 说明 |
| --- | --- | --- |
| 页面组合、配置订阅、执行订阅、选中项、撤销、连接测试 | `pages/automation/AutomationTasks.tsx` + `components/AutomationWorkspace.tsx` | 目前页面只组合工作区；流程/定时/摘要分别在独立面板 |
| 流程列表、拖拽排序、页脚与执行摘要 | `components/AutomationTaskFlowPanel.tsx` + `hooks/useTaskFlowSorting.ts` | 只接只读 Run 投影；排序预览与编辑器共享 |
| 定时编辑与通知 | `components/AutomationSchedulePanel.tsx` | 绑定定时纯模型，经工作区唯一配置 owner 写入 |
| 关卡列表编辑、次数步进、置顶、增删行 | `components/AutomationStageEditor.tsx` | 受控面板：参数经 `onUpdate(index, 'stages', value)` 写回工作区 |
| 智能养成加入/移除与在途标记 | `components/AutomationStageEditor.tsx` + `model/stageEditing.ts` | 读取 `training-queue`、调用 `generateTrainingPlan({ mode: 'current' })`；合成规则在纯模型 |
| 任务挑选菜单 | `components/AutomationTaskPicker.tsx` | 菜单开关、外部 pointerdown、Escape 回焦与运行态收起都在面板内 |
| 可添加任务目录 | `components/automationTaskCatalog.tsx` | 名称、图标、默认参数与参数字段；不读取配置/Query/执行状态 |
| 关卡分组与智能养成合成 | `model/stageEditing.ts` | 纯模型；`orderStagesForEditing` 也复用同一分组 |
| 公招招募时长校验 | `model/taskParamRules.ts` | 纯模型：10 分钟取整、60–540 夹取、非法输入回退 |
| 配置提交、pending 与 schedule 完整单元 | `user-config` 协调器 + `automationConfig` 适配器 | 面板不调用 `saveUserConfig`、不写 localStorage、不拥有提交队列 |

维护约束：

- 配置 key、pending、本地布局与 wire 形状以[配置持久化协调器](../../architecture/config-persistence.md)为准；保持 `/agent/schedules/*` 端点兼容。
- 不改变任务参数默认值、智能养成计划生成参数、执行前校验顺序或执行身份。
- 保持渲染结构、DOM/CSS 类名、表单 `id`/`aria-label`、菜单 `id`/`role`、焦点顺序与键盘行为；视觉回归遵循[开发指南](../../development/README.md)。
- 挑选面板仍把“整条流程页脚”作为点击区域：在页脚内按下指针（包括运行/停止按钮）不关闭菜单，页脚之外按下才关闭，与迁移前一致。

### 2. 组合与状态边界

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

### 3. 关卡编辑与智能养成

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

### 4. 挑选面板的焦点与键盘

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

### 5. Activity 与兼容约束

- **Activity 隐藏/恢复**：面板 state 保留；document 监听在 Effect 清理时注销，恢复后按当前 `open` 重新注册，不会遗留监听。智能养成在途 promise 继续完成，隐藏期间只更新自身状态，不写配置以外的资源。流程排序的 document 监听同样在 Activity 隐藏时清理并丢弃进行中的预览。
- **真正卸载/刷新**：菜单回到关闭，在途标记重置；配置草稿、pending 队列与 Run 身份仍由应用级所有者持有。
- 配置 key、本地存储键、迁移与 wire 形状未变化；旧草稿可直接读取。
- 默认态视觉、表单标签、菜单焦点与键盘行为继续由下列组件/页面回归覆盖。

## 回归与关联

### 回归测试

| 文件 | 覆盖 |
| --- | --- |
| `client/src/features/automation/model/flowExecution.test.ts` | 摘要来源优先级、活动/空闲/提交在途的逐项结果、当前步骤映射、单项状态与文案 |
| `client/src/features/automation/components/AutomationExecutionSummary.test.tsx` | 首次摘要前不渲染、提交在途保留上一份、失败自动展开、手动收起保持、新 run 重新展开、阶段/上报/警告详情 |
| `client/src/pages/automation/AutomationTasks.layout.test.tsx` | 活动标签；定时从 12:00 起新增至 6 行上限与重复拒绝；拖拽成功、lostpointercapture 后提交、Escape/pointercancel 取消与键盘排序；布局与表单标签、picker 菜单/焦点/Activity 恢复后 Escape、智能养成接线、公招失焦归一化与摘要接线 |
| `client/src/pages/automation/AutomationTasks.config.test.tsx` | 配置与 schedule 完整提交、半失败重试、跨 remount 串行、迟到加载与 Activity 恢复（Query Provider 包装） |
| `client/src/pages/automation/AutomationTasks.execution.test.tsx` | 单次 `run_daily_flow` 幂等提交、停止、流程进度、旧断点、摘要与 Activity 恢复；自定义换班缺文件、非法掉落目标阻止提交并选中任务 |
| `client/src/pages/automation/AutomationTasks.activity.test.tsx` | 流程结束时 Activity 隐藏再恢复，完成标记不丢失、不停止、不重提 |
| `client/src/features/automation/model/taskFlowSort.test.ts` | 10px 阈值、向上/向下插入槽位、越界原引用、成员不变量、关闭游戏最后 |
| `client/src/features/automation/model/automationSchedule.test.ts` | 解析/格式化/规范化边界、默认行独立性、12:00 起候选与跨午夜、24 小时占满、增删与启用、时/分循环与重复拒绝、`times` 往返兼容 |
| `client/src/features/automation/model/taskFlowCommands.test.ts` | 命令身份回退、添加任务的 id/参数/关闭游戏继承、恢复索引夹取、删除/启用、关卡分组不变量、`clientType` 同步、执行校验优先级、JSON 序列化形状 |
| `client/src/features/automation/model/dropTargets.test.ts` | 文本/对象形状、空白与规范化、非法条目、重复保留、格式化往返 |
| `client/src/features/automation/model/automationConfig.test.ts` | 适配器原有回归，以及命令模型输出可被现有解码接受 |
| `client/src/features/automation/utils/automationTaskProgress.test.ts` | 执行步骤映射 |
| `client/src/features/automation/model/stageEditing.test.ts` | 默认/空列表、分组一次归类与多重集合、置顶/改名/次数/步进/删除、智能养成增删与生成项、干员摘要、不可达索引原引用 |
| `client/src/features/automation/model/taskParamRules.test.ts` | 10 分钟取整、60–540 夹取、空串/非有限输入回退 |
| `client/src/features/automation/components/AutomationStageEditor.test.tsx` | 智能养成插入顺序、空队列/计划失败/抛错/材料已齐失败路径、移除保留置顶与普通行、步进与置顶写回、运行态禁用 |
| `client/src/features/automation/components/AutomationTaskPicker.test.tsx` | 目录渲染与计数、选择回调后关闭、页脚内按下不关闭/外部关闭、Escape 回焦、禁用收起 |

### 验证命令

以下命令均在仓库根目录执行。

```sh
pnpm --filter la-pluma-next-client exec vitest run src/features/automation src/pages/automation
```

完整验证与视觉回归入口见[开发指南](../../development/README.md)。

### 关联契约

- [配置持久化协调器](../../architecture/config-persistence.md)
- [前端执行客户端与控制器](../../architecture/execution-client.md)
- [Query 缓存与键规范](../../architecture/query-cache.md)
- [前端架构与所有权](../README.md)
