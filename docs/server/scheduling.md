# 日常流程与定时触发

> [← 返回文档索引](../README.md)

日常流程（任务流）是服务端把一组自动化任务串行下发给 MAA 的编排单元：计划层把配置构建成命令，执行层按步骤下发并投影进度，触发层按 cron 注册定时执行，执行结束后再统一处理通知与智能养成回写。Run 身份、停止语义、占用与持久化的完整契约见[执行身份与生命周期契约](../architecture/execution-lifecycle.md)，端点行为与错误码见 [Agent API 使用指南](../api/agent.md)。

## 模块分工

- `server/src/services/scheduleFlowPlan.ts`：纯计划构建——校验任务流、把任务条目构建为 MAA 命令或动态任务配置；不读取设备连接、用户配置或通知状态（`server/src/services/scheduleFlowPlan.ts:3-4`）。
- `server/src/services/scheduleFlowExecution.ts`：流程执行器——按步骤编排命令下发，持有停止信号与执行状态；设备命令、通知、掉落记录与养成回写全部经端口注入（`server/src/services/scheduleFlowExecution.ts:27-38`）。
- `server/src/services/scheduleFlowResult.ts`：纯结果聚合——从命令输出解析任务总结与掉落汇报结论，生成完成消息与汇总；不读取设备、存储或通知配置（`server/src/services/scheduleFlowResult.ts:11-12`）。
- `server/src/services/scheduleTaskProgress.ts`：把每个任务的步骤结论投影为轮询快照条目（`server/src/services/scheduleTaskProgress.ts:1-4`）。
- `server/src/services/scheduleTriggerService.ts`：cron 触发源注册表——注册、替换、停止 cron 计划与自动更新作业；触发回调只调用注入的执行入口，不持有流程状态（`server/src/services/scheduleTriggerService.ts:12-13`）。
- `server/src/services/scheduleSmartTrainingService.ts`：流程结束后的智能养成关卡回写，属于执行之外的存储适配（`server/src/services/scheduleSmartTrainingService.ts:9-10`）。
- `server/src/services/scheduleExecutionPorts.ts`：把 MAA/ADB 命令、日志检查点、通知与存储实现接线到执行端口（`server/src/services/scheduleExecutionPorts.ts:16-23`）。
- `server/src/services/schedulerService.ts`：组装入口——创建进程内唯一的执行器与触发注册表，保留公开入口与 Run 结算（`server/src/services/schedulerService.ts:40-58`）。

## 流程配置与任务流模型

任务流来自持久配置 `automation-tasks` 或 HTTP 请求体，公开入口保持 `unknown`，先经 `validateScheduledTaskFlow` 收窄为对象数组；校验只保证条目是对象，`id`/`name`/`params` 是执行期读取的契约字段，缺失时沿用既有运行期失败，类型层不补默认值（`server/src/services/scheduleFlowPlan.ts:7-12,304-317`）。在此之上有两条字段级校验：启用且 `mode=10000` 的自定义基建换班必须填排班文件路径；fight 任务的掉落目标必须符合 `物品ID=数量` 格式（`server/src/services/scheduleFlowPlan.ts:319-339`）。

`buildScheduledTaskCommand` 按条目分两类构建（`server/src/services/scheduleFlowPlan.ts:162-301`）：

- 带 `taskType` 的 MaaCore 动态任务生成 `run` 命令加序列化 `taskConfig`；Recruit 把 `skip_robot` 归一为 `preserve_tags: ['支援机械']`、招募时间转为数字；`mode=10000` 的基建缺文件路径直接抛错，`plan_index` 缺省为 0（`server/src/services/scheduleFlowPlan.ts:166-221`）。
- 预定义命令取 `commandId` 或 `id` 首段：`startup`/`closedown` 携带客户端类型与连接地址（及启动时的账号切换），`fight` 把多关卡折叠为 `stage1:times1,stage2:times2`，追加理智药、源石、连战倍率（负数统一用 `=` 连接下发）、掉落目标与企鹅物流/一图流汇报开关（`server/src/services/scheduleFlowPlan.ts:224-294`）。

`buildScheduledTaskFlowPlan` 把启用条目映射为纯数据计划步骤（`index`/`command`/`args`/`taskConfig`/`preActions`），执行器与确认接口共用同一份构建规则；连接默认值由调用方解析后传入，`getScheduledTaskFlowPlan` 仅在流程启用 `startup`/`closedown` 时解析连接（`server/src/services/scheduleFlowPlan.ts:100-110,344-377`、`server/src/services/schedulerService.ts:87-100`）。Agent API `run-daily-flow` 的 dry run 返回的 `plan` 即该计划（`server/src/controllers/agentExecutionController.ts:1365-1387`）。

## 步骤编排

执行器在进程内只创建一个实例，异步流程只有一个执行所有者，构造时逐个校验端口（`server/src/services/scheduleFlowExecution.ts:239-249`、`server/src/services/schedulerService.ts:50-52`）。`execute` 把整个流程包在 `withExecutionLease` 内，流程全程持有设备租约（`server/src/services/scheduleFlowExecution.ts:1360-1374`）。

编排只遍历启用的任务（`server/src/services/scheduleFlowExecution.ts:420`），按命令分支处理：

- `award`：未启用任何领取项目记跳过；开启图片通知时在领取后截图（`server/src/services/scheduleFlowExecution.ts:489-537`）。
- `startup`：先做连接检查，命令执行后最多重试 2 次，并以前台包名加截图双重确认游戏未闪退（`server/src/services/scheduleFlowExecution.ts:645-739`）。
- `recruit`/`infrast`/`mall`：不满足各自条件时记跳过；命令前打日志检查点，之后只读检查点以来的新增日志解析步骤结论，旧任务日志不进入当前结果（`server/src/services/scheduleFlowExecution.ts:501,741-917`）。
- `fight`：多关卡依次执行，每关先按客户端游戏日检查开放状态，理智耗尽后跳过剩余关卡；活动代号在下发前替换，次数是累计作战局数上限，与连战倍率同时下发（`server/src/services/scheduleFlowExecution.ts:938-1110`）。

步骤结论是 `success`/`failed`/`skipped` 的有穷联合；执行被终止时进度记 `stopped`，不把取消伪装成失败（`server/src/services/scheduleFlowExecution.ts:31-33`）。步间等待全部经 `waitForDelay`，可被停止信号中断；`stop()` 置停止标志、中止 abort controller 并取消当前延迟（`server/src/services/scheduleFlowExecution.ts:293-339`）。流程异常退出时在 `finally` 中复位执行状态，避免残留 `isRunning`（`server/src/services/scheduleFlowExecution.ts:1394-1431`）。

## 进度投影

`ScheduleExecutionStatus` 是轮询投影：`isRunning`、`scheduleId`、`runId`、`currentStep`/`totalSteps`、`currentTask`、`message`、`lastResult` 与逐任务 `taskResults`（`server/src/services/scheduleFlowExecution.ts:136-150`），经 `getScheduleExecutionStatus()` 暴露给 `GET /api/agent/schedules/execution`（`server/src/services/schedulerService.ts:105-107`、`docs/architecture/execution-lifecycle.md:39`）。逐任务条目以 `taskId` 为身份，同名任务不互相覆盖；状态为 `pending`/`running`/`success`/`failed`/`skipped`/`stopped`，完成判定停止优先于失败（`server/src/services/scheduleTaskProgress.ts:7-14,56-63`）。日常流程 Run 只在自己持有 `schedule.runId` 时投影这些步骤，未获得执行权时显示等待（`docs/architecture/execution-lifecycle.md:47-48`）。

## 结果聚合

- 每步产出一条 `ScheduleStepAction`：领取、公招、基建、信用收支、作战来自各自的结果服务，启动/关闭/关闭前仓库识别由流程直接构造（`server/src/services/scheduleFlowResult.ts:64-91`）。
- `parseTaskSummary` 从 stdout 解析关卡、次数、掉落、理智药/源石及公招、基建总结（`server/src/services/scheduleFlowResult.ts:195-283`）。
- `getFightReportResults` 按任务开关解析企鹅物流与一图流汇报结论，存在未识别掉落时判定汇报失败（`server/src/services/scheduleFlowResult.ts:141-190`）。
- `buildFlowExecutionOutcome` 生成完成消息，优先级固定：停止 > 掉落汇报失败 > 任务失败 > 正常完成（`server/src/services/scheduleFlowResult.ts:18,289-309`）。

## cron 触发源

触发源注册表按 `scheduleId` 保存 cron 计划与自动更新作业，默认注册表的执行入口是 `executeScheduledTaskFromCron`（`server/src/services/scheduleTriggerService.ts:293-309`、`server/src/services/schedulerService.ts:56-58`）。时间点归一化为去重的 `HH:MM` 并生成 `分 时 * * *` 表达式；日常流程按客户端服务区时区注册，自动更新固定 `Asia/Shanghai`（`server/src/services/scheduleTriggerService.ts:26-28,196-207,510`）。日常流程的每个时间点回调携带 `scheduleId-序号` 形式的触发标识，自动更新使用不带序号的 `scheduleId`（`server/src/services/scheduleTriggerService.ts:431`）。

注册与替换语义（`server/src/services/scheduleTriggerService.ts:407-490,522-548`）：

- 注册时快照任务流程与配置，之后的请求体变动不影响已登记触发（`server/src/services/scheduleTriggerService.ts:421-423`）。
- 重复配置同一 `scheduleId` 原子替换：任一时间点注册成功即切换到新注册并销毁旧注册；全部时间点都注册失败时保留上一份有效注册并返回失败（`server/src/services/scheduleTriggerService.ts:452-490,522-529`）。
- 部分失败分两种：个别时间点注册失败时替换照常生效，返回仍为成功，缺失时间点靠返回的 `times` 暴露（`server/src/services/scheduleTriggerService.ts:482,549-553`）；旧 job 销毁失败时新注册同样已生效，但按 `success:false` 返回并附逐时间点错误（`server/src/services/scheduleTriggerService.ts:537-548`）。
- 已排队的回调在触发时检查注册身份与 draining 状态，重配、停止或关闭后直接丢弃；`run()` 同步调用执行入口，避免 draining 从 Run 创建与执行之间插入（`server/src/services/scheduleTriggerService.ts:365-405`）。

`stopSchedule` 对未注册目标幂等；`stopAll` 只在首次调用生成摘要，销毁后拒绝新注册（`server/src/services/scheduleTriggerService.ts:622-685`）。`attachScheduleTriggersToLifecycle` 先挂 draining 判断再注册关闭步骤，同一 lifecycle 重复接入返回 `duplicate`，挂接第二个注册表直接抛错（`server/src/services/scheduleTriggerService.ts:742-781`）。自动更新显式禁用或缺少时间点即停止并移除，无效输入不清空既有注册；作业本体在 MAA 执行租约内更新核心、资源与 CLI（`server/src/services/scheduleTriggerService.ts:212-269,556-577`）。

## 设备租约与 Run

cron 触发在执行前经 `beginAgentRun` 创建 `run_daily_flow` Run，`onBeforeStart` 在取得租约后、第一步之前经 `startAgentRunForExecution` 复核身份；流程结束后按实际执行结果结算 Run 终态，不由触发时机推断（`server/src/services/schedulerService.ts:118-147,183-214`、`server/src/services/scheduleFlowExecution.ts:414-417`）。HTTP 入口由控制器创建 Run 并把 `runId` 传入 `executeScheduleNow`；不经 Run 包装的直接调用方（如 Telegram）`runId` 为 `null`，以 `external` 占用出现在快照中。租约被其他执行占用时流程返回 `busy:true` 与 `owner`，供 HTTP 映射 409（`server/src/services/scheduleFlowExecution.ts:1376-1387`）。Run 终态、幂等与停止矩阵见[执行身份与生命周期契约](../architecture/execution-lifecycle.md)。

## 完成通知与掉落汇报时序

执行期间：每关解析出任务总结后立即写入掉落记录；开启图片通知时在领取奖励后截图（`server/src/services/scheduleFlowExecution.ts:349-366,526-537,1050-1060`）。流程持有租约期间只把完成载荷挂到结果对象上；`dispatchCompletion` 对每个结果只消费一次，在租约释放且 Run 结算落盘之后运行，先刷新智能养成关卡再发送完成通知，副作用错误显式返回、只记日志，不改写已结算的 Run 终态（`server/src/services/scheduleFlowExecution.ts:173-177,1300-1358`、`server/src/services/schedulerService.ts:157-173,216-221`）。cron 路径在 Run 结算后同步执行副作用；HTTP 手动路径把副作用放到 `setImmediate` 并先落盘 Run，避免通知占用租约或早于终态落库（`server/src/services/schedulerService.ts:286-301`）。

## 智能养成关卡回写

`refreshSmartTrainingStages` 端口接线到 `updateSmartTrainingStages`（`server/src/services/scheduleExecutionPorts.ts:59`）。回写流程（`server/src/services/scheduleSmartTrainingService.ts:137-302`）：

1. 读取 `automation-tasks`，定位第一个带智能关卡的 fight 任务；没有则跳过。
2. 读取 `training-queue`：队列为空时移除全部智能关卡并保存。
3. 按连接 profile 的客户端类型重新生成 `current` 刷取计划；连接解析失败时按默认客户端生成，不阻断回写（`server/src/services/scheduleSmartTrainingService.ts:69-79`）。
4. 计划为空时按设置自动切换到下一个干员（移出已完成项并重新生成计划），未开启自动切换或队列只剩一项则移除智能关卡。
5. 今天没有开放关卡时移除智能关卡；否则用开放的智能关卡替换，保留固定（`pinned`）关卡与普通关卡（`server/src/services/scheduleSmartTrainingService.ts:116-125`）。

写回的智能关卡条目为 `{stage, times, smart: true, trainingOperators}`（`server/src/services/scheduleSmartTrainingService.ts:35-41`）。

## 重启恢复

运行时初始化在读取持久配置前先把触发源注册表接入生命周期，保证恢复失败时关闭流程仍能停止之后注册的 cron（`server/src/services/runtimeInitializationService.ts:140-172`）。恢复读取 `automation-tasks` 与 `auto-update` 配置：启用的默认定时任务按已保存的时间点与任务流重新注册，客户端类型取当前连接 profile，解析失败时按默认客户端时区恢复；自动更新同理。恢复只注册触发源、不执行流程，与被中断的 Run 没有续跑关系（`server/src/services/runtimeInitializationService.ts:181-248`、`docs/architecture/execution-lifecycle.md:252`）。

## 测试入口

| 测试 | 固定的行为 |
| --- | --- |
| `server/src/services/__tests__/scheduleFlowExecutionPorts.test.ts` | 流程步骤与端口边界、可中止的步间等待、完成副作用在租约释放后消费、副作用错误显式返回（[执行身份与生命周期契约](../architecture/execution-lifecycle.md#8-契约测试清单)） |
| `server/src/services/__tests__/schedulerRecovery.test.ts` | 异常复位、pre-start 门禁、cron 产生单个带终态结果的 `run_daily_flow`、副作用在 Run 结算后执行、占用 fail-closed（[执行身份与生命周期契约](../architecture/execution-lifecycle.md#8-契约测试清单)） |
| `server/src/services/__tests__/scheduleTriggerLifecycle.test.ts` | 重复配置替换不叠加、全部/部分注册失败、销毁失败上报、draining 拒绝注册并丢弃排队回调（[执行身份与生命周期契约](../architecture/execution-lifecycle.md#8-契约测试清单)） |
| `server/src/services/__tests__/schedulerPlan.test.ts` | 计划构建与校验经公开入口与执行共用同一份动态任务配置 |
| `server/src/services/__tests__/scheduleSmartTrainingService.test.ts` | 智能养成回写的计划生成、队列切换与关卡替换 |
| `server/src/services/__tests__/scheduleTaskProgress.test.ts` | 逐任务进度投影与停止优先的状态判定 |

回归命令：`pnpm --filter la-pluma-next-server test`；定向验证单个文件可用 `node --test server/src/services/__tests__/scheduleTriggerLifecycle.test.ts`，测试入口见[服务端架构与请求契约](README.md#测试入口)。
