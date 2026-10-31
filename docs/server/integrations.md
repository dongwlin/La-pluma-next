# MAA、ADB 与通知渠道

> [← 返回文档索引](../README.md)

本文描述服务端与外部系统的集成行为：MAA CLI 子进程与日志流、执行租约与动态任务、MAA profile 与连接解析、ADB 设备探测、MAA 日志文件、活动查询与任务缓存、MaaCore 回调解析与各领域结果服务，以及 Telegram 通知渠道与 Bot 轮询。

这些模块只产出步骤结论与子进程投影；Run 身份与租约的完整语义见[执行身份与生命周期契约](../architecture/execution-lifecycle.md)，HTTP 端点与命令白名单见 [Agent API 使用指南](../api/agent.md)。文档与代码冲突时以代码为准。

## MAA CLI 子进程与实时日志

MAA CLI 可执行文件路径在模块导入时按 `MAA_CLI_PATH` 解析一次：Docker 缺省 `/usr/local/bin/maa`，本地缺省 `maa`（`server/src/config/connectionDefaults.ts:18-23`、`server/src/config/runtimeConfig.ts:271-276`）。

- `maaProcessService` 是唯一持有可写子进程状态 `taskStatus` 与实时日志缓冲的模块（`server/src/services/maaProcessService.ts:281-291`）。对外投影 `getTaskStatus` 只回答"是否有受管子进程、任务名与停止请求"，不能当作流程或 Run 终态（`server/src/services/maaProcessService.ts:293-303`）。
- 命令按三种形态执行：
  - 带任务名且不等待完成时用 `spawn` 后台执行：非 Windows 加 `detached`，stdio 为 `ignore/pipe/pipe`，spawn 后立即返回"任务已在后台启动"（`server/src/services/maaProcessService.ts:715-722,767-773`）。
  - 带任务名且等待完成时同样 `spawn`，但等待 `close` 后才 resolve 或 reject，失败错误携带 stdout/stderr、退出码、信号与诊断信息（`server/src/services/maaProcessService.ts:810-908`）。
  - 无任务名的诊断/配置类命令用 `execFile` 同步执行，缺省 15 秒超时并 SIGKILL（`server/src/services/maaProcessService.ts:240,910-922`）。
- 子进程 stdout/stderr 按行写入实时缓冲；stderr 行内含 `ERROR` 或 `WARN` 时提升日志级别（`server/src/services/maaProcessService.ts:727-749`）。
- 实时日志条目经脱敏后写入，并携带执行上下文的 `runId`/`operationId`——归属来自执行上下文而不是发起请求，请求返回后仍在运行的子进程输出继续携带同一标识（`server/src/services/maaProcessService.ts:333-347`）。
- 实时缓冲的内存上限由 `LA_PLUMA_MAX_REALTIME_LOGS` 控制，缺省 5000，非法环境变量回落默认值（`server/src/services/maaProcessService.ts:37-51`）；对外单次返回行数上限为 `MAX_REALTIME_LOG_LINES` 500（`server/src/services/maaProcessService.ts:35,308-318`）。
- 后台执行可能持续很久：捕获输出只保留最后 256 KB（`server/src/services/maaProcessService.ts:488-521`），任务结束时单条日志最多写入 8 KB 尾部输出（`server/src/services/maaProcessService.ts:491,524-531`）。
- stderr 会匹配稳定的诊断码并写入日志：未知掉落、企鹅物流/一图流汇报失败、ADB 连接失败、账号切换失败、游戏启动失败（`server/src/services/maaProcessService.ts:377-434`）。
- `stopCurrentTask` 先按进程组发 SIGTERM（非 Windows；ESRCH 回落到子进程信号），缺省 3000ms 未退出升级 SIGKILL；重复停止只返回等待中，不重复发送信号（`server/src/services/maaProcessService.ts:966-1029`）。
- 退出语义：只有 `stopRequested` 置位的退出算 `stopped`；外部信号（OOM、SIGSEGV、被其他进程 kill）属于失败，保留退出码与信号信息（`server/src/services/maaProcessService.ts:543-580`）。
- 生命周期回调 `onBeforeStart`/`onStarted`/`onSettled` 可注入；`onSettled` 只在子进程真实退出或启动失败时运行，后台 HTTP 返回不触发（`server/src/services/maaProcessService.ts:212-220`）。spawn、execFile、停止信号与强制终止计时器都是可注入端口（`server/src/services/maaProcessService.ts:148-154,262-279`）。

## 执行租约与命令构建

- `maaExecutionService` 维护固定的设备变更命令集合，`requiresMaaExecutionLease` 据此决定是否先取得 `executionCoordinatorService` 的执行租约（`server/src/services/maaExecutionService.ts:33-37,117-119`）。
- `execMaaCommand` 在取得租约后先运行 `onBeforeStart` 门禁再 spawn；后台执行的租约在子进程实际退出（`onSettled`）后释放，HTTP 返回"已启动"响应不等于执行完成、也不释放租约（`server/src/services/maaExecutionService.ts:176-228`）。非设备变更命令直接进入子进程模块，不申请租约（`server/src/services/maaExecutionService.ts:186-188`）。
- 动态任务 `execDynamicTask` 在 MAA 配置目录的 `tasks/` 下写临时 TOML 后以 `run` 执行：文件名净化为字母数字并附加随机 nonce；`[[tasks]]` 与 `[tasks.params]` 表由配置对象生成，字符串形式的数组参数会尝试 JSON 解析（`server/src/services/maaExecutionService.ts:270-376,381-442`）。
- 动态任务的临时文件与租约在失败和完成时都清理释放；`MAA_EXECUTION_BUSY` 与 `stopped` 错误原样抛出，其余错误重建字段后抛出（`server/src/services/maaExecutionService.ts:296-311,368-375`）。
- `getMaaVersion` 执行 `maa version` 并解析输出中的 `maa-cli` 与 `MaaCore` 版本行（`server/src/services/maaExecutionService.ts:233-255`）。

## profile 与连接配置

- MAA 配置目录由 `maa dir config` 解析并按进程缓存：并发调用共享同一次查询，失败在 30 秒冷却期内复用同一错误，避免 CLI 故障期间反复 spawn（`server/src/services/maaConfigService.ts:55-82`）。
- profile 名必须匹配 `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`；配置路径经 `resolve` 后校验未越出 `profiles/` 目录，拒绝路径穿越（`server/src/services/maaConfigService.ts:87-103`）。
- 读取 profile 时只返回 `connection` section；文件不存在或读取失败时返回环境默认连接 `adb_path`/`address`/`config`（`server/src/services/maaConfigService.ts:147-163`）。
- 保存配置走 `updateTextFile` 的读改写排队单元与文本原子替换：同一 profile 的读取、合并与写入串行完成，解析或写入失败时不写回、已有配置保持原样（`server/src/services/maaConfigService.ts:168-185`）。
- `connectionService.resolveConnection` 是执行、预览、定时与维护入口共用的连接解析：profile 值按 `snake_case` 优先、`camelCase` 兼容，只有非空字符串生效，其余回落连接默认值；profile 名不合法抛 400 `AGENT_VALIDATION_PROFILE_ID_INVALID`（`server/src/services/connectionService.ts:73-96`）。
- `resolveConnectionInput` 只在调用方声明 `allowOverrides` 时应用请求级显式覆盖；空白或缺失的覆盖值保留 profile 值（`server/src/services/connectionService.ts:102-117`）。

## ADB 探测、连接测试与截图

`maaDeviceService` 只读设备事实，不持有任务状态、执行租约或 Run 终态（`server/src/services/maaDeviceService.ts:10-19`）。

- ADB 路径与地址在进入子进程前统一校验：路径拒绝 shell 元字符（Windows 绝对路径单独放行），地址限 `host:port` 或 `emulator-<serial>` 形态（`server/src/services/maaDeviceService.ts:127-150`）。
- `discoverAdbDevices` 合并三类来源：
  - 当前 ADB 的 `adb devices -l`（`server/src/services/maaDeviceService.ts:384-392`）。
  - Windows 上运行中模拟器进程旁的内置 ADB：按进程名匹配 BlueStacks、LDPlayer、夜神、MuMu、逍遥，并在进程目录及其上级目录检查内置 adb 可执行文件（`server/src/services/maaDeviceService.ts:244-309`）。
  - 五个常见本机模拟器端口的 TCP 探测候选；候选状态为 `candidate`，不会被自动连接（`server/src/services/maaDeviceService.ts:25-31,210-227,397-409`）。
- 设备按地址合并，同名 serial 优先采用当前配置 ADB 的结果（`server/src/services/maaDeviceService.ts:343-354`）。
- `testAdbConnection` 依次检查 `adb version` 与设备列表状态：`device` 直接成功，`unauthorized`/`offline` 返回对应提示；否则尝试 `connect`，等待 1 秒后复查状态（`server/src/services/maaDeviceService.ts:466-548`）。
- `getGameClientState` 用 `dumpsys window` 解析前台包名（优先 `mCurrentFocus`，回落 `mFocusedApp`），与客户端类型对应的期望包名比对（`server/src/services/maaDeviceService.ts:39-46,435-461`）。
- `captureScreen` 分三步执行并按步骤设置超时与 SIGKILL：检查设备 3 秒、按需连接 5 秒、`exec-out screencap -p` 读取屏幕 8 秒；超时错误标注失败步骤，图像以 base64 与采集时间返回（`server/src/services/maaDeviceService.ts:553-614`）。

## 日志文件边界与检查点

- MAA 日志目录由 `maa dir log` 解析并按进程缓存，失败同样有 30 秒冷却（`server/src/services/maaLogFileService.ts:105-128`）。文件列表递归收集目录内 `.log` 文件并按修改时间倒序（`server/src/services/maaLogFileService.ts:130-154,212-224`）。
- `readLogFile` 先对日志目录与请求路径取 `realpath`，再按目录边界判定与扩展名检查：只允许日志目录内的 `.log` 文件，目录外符号链接与悬空目标都被拒绝（`server/src/services/maaLogFileService.ts:268-278,337-349`）。
- 日志内容从文件尾部按 64 KB 分块读取，单次最多 2 MB；窗口起始于行中间时丢弃首行残片。`totalLines` 按 split 语义分块统计换行数；行数上限 `MAX_LOG_FILE_LINES` 5000（`server/src/services/maaLogFileService.ts:24,27,284-329,337-381`）。
- `cleanupLogs` 按修改时间从新到旧累加，把超出保留上限的文件删除；上限限定 1–1024 MB（`server/src/services/maaLogFileService.ts:229-262`）。
- 执行前检查点 `createMaaLogCheckpoint` 记录 `asst.log` 当前字节数，失败返回 null 不抛错；`readMaaLogSince` 只读取检查点之后新增的字节（最多 `maxBytes`），失败返回空串（`server/src/services/maaLogFileService.ts:160-207`）。调度中的回调结果读取依赖这对检查点与增量读取，不把旧任务日志算入当前结果（`server/AGENTS.md:28`）。
- 调试截图列表从 MAA 状态目录的 `debug/` 读取图片文件；响应只暴露文件名，不返回服务器绝对路径（`server/src/services/maaLogFileService.ts:386-424`）。

## 活动查询与本地任务缓存

- `maaActivityService` 产出带状态的快照：`active`/`none` 是来源给出的肯定答案，`stale` 是全部来源失败但保留了上次成功数据，`unavailable` 是既无可确认结果也无旧数据（`server/src/services/maaActivityService.ts:41-42`）。
- 读取顺序为内存缓存 → 持久化 `activity-cache` 用户配置 → 短负缓存 → `maa activity` → 备用数据源；同一 `clientType` 的并发调用共享同一次在途查询（`server/src/services/maaActivityService.ts:564-626`）。正缓存 TTL 10 分钟、负缓存 60 秒（`server/src/services/maaActivityService.ts:30,36`）。
- 解析不出活动代号的结果只进短负缓存，不写正缓存，避免每次轮询重复启动 CLI（`server/src/services/maaActivityService.ts:653-655,740-749`）。
- CLI 空输出不能单独证明"没有活动"：还需 MAA 活动表 `StageActivityV2.json` 存在且在 24 小时内与远端确认过——确认时间取 ETag 旁注文件 mtime 与内容 mtime 的较大者（`server/src/services/maaActivityService.ts:82-92,281-291,660-683`）。
- 活动缓存持久化经 `configStorageService` 的 `activity-cache` 受控类型，读改写合并其他服务区条目；保存失败只告警，不否决本次读取结果（`server/src/services/maaActivityService.ts:752-775`）。
- 资源收集全开放窗口从活动表 `resourceCollection` 节点解析（服务区当地时刻减 `TimeZone` 小时得 UTC）；成功结果（包括"表里没有窗口"）缓存 60 秒，读取失败只退避 5 秒，窗口不可读时按周表判定关卡开放（`server/src/services/maaActivityService.ts:326-468`）。
- `replaceActivityCode` 把 `hd-数字` 关卡代号替换为当前活动代号；取不到代号时保持原值（`server/src/services/maaActivityService.ts:780-802`）。
- `maaTaskCacheService.prepareMaaTaskCache` 在执行本地资源命令前，把共享缓存中的热更新文件快照进 `mkdtemp` 临时目录并写入私有 ETag 旁注文件，使 maa-cli 强制的启动更新保持本地而不标记真实缓存为已远端确认；`MAA_CACHE_DIR` 环境变量优先于 `maa dir cache` 查询（`server/src/services/maaTaskCacheService.ts:17-19,50-69,106-134`）。
- 该任务缓存由 `execMaaCommandUnlocked` 挂接：后台任务在子进程退出后清理，其余命令在返回前清理（`server/src/services/maaProcessService.ts:652-685`）。

## 回调解析与领域结果服务

- `maaCallbackService.parseMaaCallbackEvents` 只保留 `Assistant::append_callback | ` 标记行中 `taskchain` 与目标值一致的 JSON 对象载荷；断行、非法 JSON、非对象载荷与其他 taskchain 一律跳过，因此增量日志从半行开始也不会产生错误事件（`server/src/services/maaCallbackService.ts:12,34-69`）。
- `details`、`what`、`class`、子任务名与字符串列表都由读取函数逐字段收窄；缺字段或类型不符按"未观察到"处理，不会中断解析（`server/src/services/maaCallbackService.ts:72-106`）。
- 五个结果服务都只描述单次步骤的检查结论（`success`/`failed`/`skipped`），不能当作整个 Run 的终态；`skipped`、`failed` 与 `success` 不可混同（`server/AGENTS.md:28`）。
- award 不依赖结构化回调：按日志中 `"first":["<BeginTask>"]` 分段和分段内 `"task":"..."` 事件判断六个领取项是否已领取；未启用任何项目返回单项 `skipped`，分段缺失时回退为"流程已完成"（`server/src/services/awardResultService.ts:84-153`）。
- recruit 解析 `Recruit` taskchain：统计开始/收取/加急/刷新次数与最高星级，`TaskChainError` 为 `failed`，保留标签或许可不足为 `skipped`；无事件时回退"流程已完成"（`server/src/services/recruitResultService.ts:60-174`）。
- infrast 解析 `Infrast` taskchain：按 `class` 字段映射九类设施，识别收产物、换班、无人机、线索收送与交流、专精训练；未选择设施返回 `skipped`（`server/src/services/infrastResultService.ts:60-192`）。
- mall 解析 `Mall` taskchain：好友访问、信用购物、信用作战三项严格 `false` 才整体跳过；购买计数只统计 `exec_times` 缺失或为 1 的 `CreditShop-Bought` 事件（`server/src/services/mallResultService.ts:40-139`）。
- fight 基于任务总结、命令输出与错误文本：理智耗尽、关卡未开放、剿灭奖励已领完归为 `skipped`，其余错误为 `failed`；理智判定同时检查输出短语与 Summary 段（`server/src/services/fightResultService.ts:56-178`）。

## 通知发送与 Telegram Bot 轮询

- `createNotificationService` 创建持有配置、渠道注册表与出站端口的实例；渠道注册表当前只有 `telegram`，微信、钉钉、邮件、Bark 为预留（`server/src/services/notificationService.ts:362-388,602-614,734-753`）。
- `sendNotification` 只发给启用渠道；单渠道失败记入 `errors`，不阻断其他渠道。总开关关闭时直接返回"通知功能未启用"（`server/src/services/notificationService.ts:645-683`）。
- `shouldCaptureScreenshot` 在存在配置完备且支持图片的启用渠道时为 true（`server/src/services/notificationService.ts:631-640,748,772-774`）。
- Telegram 渠道文本消息用 `sendMessage` 加 Markdown；图片消息用原生 FormData/Blob 构造 multipart `sendPhoto`。图片超过 10MB 或三次重试（间隔 2 秒、4 秒）后仍失败时回退纯文本消息（`server/src/services/notificationService.ts:439-548`）。
- 渠道凭据（botToken）只存在于运行时配置，不进入发送结果 DTO 或日志；`getConfig` 返回完整配置且与运行时配置不共享引用（`server/src/services/notificationService.ts:7-11,625-629`）。
- `testChannel` 支持仅用于本次测试的配置覆盖，走同一解析边界，不写回运行时配置（`server/src/services/notificationService.ts:707-727`）。
- `buildTaskCompletionMessage` 按 actions/reports 中的失败与跳过条目归一化通知级别与标题（success/warning/info），并组装执行结果、掉落汇报、任务总结、跳过与失败任务段落（`server/src/services/notificationService.ts:803-972`）。
- Telegram Bot 是独立的命令接收通道，进程级默认实例绑定真实出站端口与 MAA 服务（`server/src/services/telegramBotService.ts:491-506,1664-1671`）。
- 同一实例同一时刻只有一个轮询会话：`init` 先同步停止旧会话再按新配置启动；旧会话的在途请求被中止，迟到更新不再派发命令（`server/src/services/telegramBotService.ts:625-656`）。
- 长轮询停留 30 秒、请求时限 40 秒，`getUpdates` 为 POST 且出站端口不自动重放；无更新间隔 2 秒、出错重试 5 秒；多实例 `Conflict: terminated by other getUpdates` 错误静默降级；offset 在派发更新时推进（`server/src/services/telegramBotService.ts:47-53,698-767`）。
- 会话持有独立 AbortController：长轮询请求、轮询间隔、等待与命令内倒计时绑定同一 signal；`attachLifecycle` 把停止能力注册进运行时关闭流程，同一 lifecycle 只注册一次（`server/src/services/telegramBotService.ts:77-85,679-693`）。
- 授权优先 `allowedUserIds`，为空时按单 `chatId` 兼容比较 chat 或 user ID；缺少整数 `update_id` 的更新被忽略，非文本消息或缺少 chat/from 的条目只推进 offset（`server/src/services/telegramBotService.ts:306-327,769-775`）。
- 文本按"作业 URI → 关键词 → 带参关键词 → `/命令`"顺序解析为命令领域输入（`server/src/services/telegramBotService.ts:392-483`）。startup、fight、copilot、roguelike 命令先停止当前任务再执行新任务；`/run` 流程直接调用 `executeScheduleNow`，不创建 HTTP Run 包装（`server/src/services/telegramBotService.ts:841-882,1358-1471`）。
- 启动初始化读取持久化 `notification` 配置恢复通知服务，再以其中 `channels.telegram`（叠加当前 profile 的 ADB 路径与地址）启动 Bot；未启用时不启动轮询，生命周期接入失败则放弃本次启动（`server/src/services/runtimeInitializationService.ts:181-196,250-274`）。

## 测试用假 CLI 与临时目录

- 子进程测试不启动真实 CLI：spawn/execFile/停止端口注入同形状的假子进程，覆盖 close/error、退出码、信号与 kill 升级（`server/src/services/maaProcessService.ts:88-101`、`server/src/services/__tests__/maaServicePorts.test.ts:85`）。
- 需要真实进程行为的测试在临时目录写入可执行的假 CLI 脚本，并在模块导入前设置 `MAA_CLI_PATH` 等环境变量；导入时读取的环境变量必须在导入前设置（`server/src/services/__tests__/maaConfigDirCache.test.ts:7-32`、`server/AGENTS.md:53`）。
- MAA 缓存、profile 目录与任务缓存目录用 `mkdtemp` 隔离，用例结束后删除（`server/src/services/__tests__/maaConfigDirCache.test.ts:9,43-45`、`server/src/services/__tests__/maaTaskCacheService.test.ts:10`）。
- 外部依赖整体可注入：活动查询的 runtime（`server/src/services/maaActivityService.ts:94-108`）、日志检查点的 stat/open 端口（`server/src/services/maaLogFileService.ts:61-69`）、通知服务的出站客户端（`server/src/services/notificationService.ts:574-580`）与 Telegram Bot 的全部依赖（`server/src/services/telegramBotService.ts:218-232`），测试不触碰真实网络、设备或 MAA CLI。
- 测试入口、逐文件进程隔离与定向回归命令见[服务端架构与请求契约](README.md#测试入口)。

## 延伸阅读

- [执行身份与生命周期契约](../architecture/execution-lifecycle.md)：Run 身份、租约、停止与持久化语义。
- [Agent API 使用指南](../api/agent.md)：端点、命令白名单与错误码。
- [持久化与运行数据](persistence.md)：MAA profile、日志与运行数据的落盘位置与恢复语义。
- [服务端开发指南](../../server/AGENTS.md)：执行与回调边界的修改约束及验证命令。
