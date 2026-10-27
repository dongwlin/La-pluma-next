# 自动化纯模型与排序

> [← 返回文档索引](README.md)

本文说明自动化规则纯模型：定时时间、任务流程命令、拖拽排序与掉落目标解析。配置提交仍由 [`automationConfig.ts`](../client/src/features/automation/model/automationConfig.ts) 适配器与 `user-config` 协调器持有，执行仍由 `task-execution` 控制器与服务端 Run 持有；当前指针/键盘接线由 `hooks/useTaskFlowSorting.ts` 持有，逐项执行状态与摘要来源由 `model/flowExecution.ts` 提供，模型本身仍不访问 React、网络或存储。

相关契约：[自动化流程、定时与执行摘要面板](automation-flow-panels.md)、[自动化任务编辑面板](automation-editor.md)、[配置持久化协调器](config-persistence.md)、[前端执行客户端与控制器](execution-client.md)、[前端架构与所有权](frontend-architecture.md)。

## 1. 定位与边界

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

## 2. 定时时间规则

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

## 3. 任务流程命令规则

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

## 4. 排序规则与不变量

| 规则 | 行为 |
| --- | --- |
| 拖拽阈值 | `hasPointerSortActivated` 使用欧氏距离，位移 `>= 10px` 才激活；常量 `POINTER_SORT_ACTIVATION_PX` 为 10 |
| 目标索引 | `getPointerSortTargetIndex` 先移除被拖拽项，再按其余任务中线计算插入槽位；无法读取中线的任务被跳过；被拖拽项不在流程中返回 `-1` |
| 重排 | `moveTaskFlowItem` 对同位置、越界或缺失源项返回原数组引用；合法移动返回新数组，长度为 `[0, length)` 的目标索引直接配合拖拽槽位 |
| 不变量 | 每次合法移动都保持长度与成员多重集合；移动后再移回恢复原顺序；键盘上下移动与拖拽共用同一函数 |
| 关闭游戏 | `placeClosedownLast` 把 `commandId === 'closedown'` 或 id 以 `closedown-` 开头的任务稳定地移到末尾，其余任务保持相对顺序 |
| 引用判定 | 排序 hook 用 `newFlow === currentFlow` 判断键盘移动是否需要提交，因此无效移动必须返回原引用 |

`automationConfig.ts` 的载荷解码也调用同一个 `placeClosedownLast`，持久化顺序与页面编辑顺序不会分叉。

## 5. 掉落目标格式

`fight.params.drops` 支持两种历史形状：

- 文本：`30011=10,30062=5`，条目两端允许空白，`=` 两侧允许空白；
- 旧对象：`{ "30011": 10, "30062": "5" }`。

规则：

- 物品 ID 只允许字母、数字、`_`、`-`；数量必须是正整数，`0`、负数、小数与非数字都使整份输入无效；
- 任一条目非法时 `parseDropTargets` 返回 `null`，执行前校验据此阻止提交；
- 空值（`undefined`/`null`/`''`）解析为空数组，表示未设置目标；
- 重复条目保留原顺序，不做去重，兼容旧草稿；
- `formatDropTargets` 输出无空格的规范文本，与 `parseDropTargets` 互为逆变换。

## 6. 兼容与视觉约束

- 配置 key、pending、本地布局与 wire 形状以[配置持久化协调器](config-persistence.md)为准；本域纯模型保留 `entries`/`times` 兼容读取。
- 新任务仍携带 `defaultParams` 且不含 `icon`/`paramFields`；模型输出已由 `automationConfigAdapter.decodeDraft` 的回归用例验证可被现有迁移接受。
- 面板 DOM/CSS、表单 id、`aria-label`、拖拽手柄与键盘行为不变；没有新增 CSS，也没有更新视觉基线。

## 7. 回归测试

| 文件 | 覆盖 |
| --- | --- |
| `model/automationSchedule.test.ts` | 解析/格式化/规范化边界、默认行独立性、12:00 起候选与跨午夜、24 小时占满、增删与启用、时/分循环与重复拒绝、`times` 往返兼容 |
| `model/taskFlowCommands.test.ts` | 命令身份回退、添加任务的 id/参数/关闭游戏继承、恢复索引夹取、删除/启用、关卡分组不变量、`clientType` 同步、执行校验优先级、JSON 序列化形状 |
| `model/taskFlowSort.test.ts` | 10px 阈值、向上/向下插入槽位、越界原引用、成员不变量、关闭游戏最后 |
| `model/dropTargets.test.ts` | 文本/对象形状、空白与规范化、非法条目、重复保留、格式化往返 |
| `model/automationConfig.test.ts` | 适配器原有回归，以及命令模型输出可被现有解码接受 |
| `model/flowExecution.test.ts` | 最近执行来源、活动/空闲/提交在途的逐项结果、当前步骤映射、单项状态与文案 |
| `utils/automationTaskProgress.test.ts` | 既有执行步骤映射（从页面测试迁入工具入口） |
| `pages/automation/AutomationTasks.execution.test.tsx` | 自定义换班缺文件与非法掉落目标阻止提交并选中任务 |
| `pages/automation/AutomationTasks.layout.test.tsx` | 定时新增从 12:00 起接续到 6 行上限、重复时间拒绝；拖拽成功/Escape/pointercancel、键盘排序；既有布局与表单接线 |

针对性命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client exec vitest run src/features/automation src/pages/automation
```

## 关联

- [自动化流程、定时与执行摘要面板](automation-flow-panels.md)：面板组合、排序指针生命周期与执行摘要。
- [自动化任务编辑面板](automation-editor.md)：StageEditor/TaskPicker 的组合、局部交互状态与智能养成接线。
- [配置持久化协调器](config-persistence.md)：`automationConfig` 编解码、完整提交与重试边界。
- [前端执行客户端与控制器](execution-client.md)：提交、停止与 Run 身份。
