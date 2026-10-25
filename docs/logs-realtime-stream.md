# 实时日志流生命周期

> [← 返回文档索引](README.md)

本文描述 FPR-027 交付的日志实时读取所有者与纯模型。它回答：实时日志由谁读取和缓冲；轮询频率、协议与快照语义是什么；页面隐藏、浏览器文档隐藏和手动暂停分别如何停止与恢复；解析、摘要、过滤和折叠如何脱离页面测试。

## 1. 归属与边界

| 内容 | 唯一归属 | 说明 |
| --- | --- | --- |
| 实时缓冲、轮询计时器、请求取消与暂停状态 | `client/src/features/logs/model/realtimeLogStream.ts` 的 `RealtimeLogStream` | 会话数据，不进入 Query；同一时刻最多一个在途读取 |
| 页面生命周期接线 | `client/src/features/logs/hooks/useRealtimeLogs.ts` | 实例寿命、`useSyncExternalStore` 订阅、Activity 启停与 `document` 可见性转发 |
| 解析、级别归一、摘要、过滤与重复折叠 | `client/src/features/logs/model/logModel.ts` | 纯函数，不依赖 React、网络或 DOM |
| 工具栏、模式切换、自滚动与历史浏览 | `client/src/features/logs/pages/LogViewer.tsx` | 历史文件读取、返回实时、清空与历史清理的完整协调仍归 FPR-028 |

实时流实例随日志页真正挂载创建。React Activity 隐藏会清理 Effects 但保留组件状态与实例，因此恢复后缓冲、过滤和选择仍在；浏览器刷新或真正重挂载会创建新实例，缓冲从头开始。实时日志没有持久化，也没有跨标签页共享。

## 2. 读取协议与快照语义

| 项目 | 当前值 | 依据 |
| --- | --- | --- |
| 端点 | `GET /api/agent/logs/recent?lines=200` | `features/logs/api` 的 `getRealtimeLogs` |
| 行数 | 客户端固定读取最近 200 行；服务端把 `lines` 限制在 1–500 | `REALTIME_LOG_LINES`、`server/routes/agent.js` |
| 轮询间隔 | 1250ms | `REALTIME_LOG_INTERVAL_MS`，与迁移前页面计时器一致 |
| 响应形状 | `LogEntry` 数组，每项含 `time`、`level`、`message` | 服务端 `getRealtimeLogs` 返回内存缓冲切片 |
| 缓冲方式 | 每次响应整体替换当前 200 行快照，不追加 | 服务端只返回最近行，没有增量标识 |

协议没有 `cursor`、`since`、`offset` 或递增序号，因此**增量游标不适用**，本次也没有扩展服务端协议。清空实时日志后，服务端内存缓冲归零，客户端在恢复轮询时重新读取空快照。

慢请求不会造成请求重叠：若一次读取超过 1250ms，到点的轮询被跳过；响应落定后，下一个到点轮询继续。这样在慢网络下实际刷新频率由响应时间决定，而不是叠加请求。

## 3. 请求控制与旧响应裁决

- 每次读取创建独立 `AbortController`，`signal` 一直传到 `fetch`。
- 同一时刻只保留一个在途请求；`start()`、`refresh()`、文档可见与手动恢复都经过同一守卫。
- 只有仍是当前请求且 signal 未中止的响应可以写入缓冲。页面隐藏、文档隐藏、手动暂停、清空前暂停、历史模式切换或新请求取代旧请求后，迟到响应一律丢弃。
- 请求失败保留上一份缓冲，只更新错误提示；用户点击“重新加载”调用 `refresh()`，已有在途请求时仍保持单在途语义。
- `AbortError` 不记为失败；取消不会清空缓冲，也不显示错误。

## 4. 生命周期与恢复

| 事件 | 实时流行为 | 页面结果 |
| --- | --- | --- |
| Activity 隐藏或页面真正卸载 | `stop()`：清计时器、取消在途读取，保留缓冲 | Effects 清理；历史文件读取沿用现有 mounted 守卫（隐藏期间完成的读取仍可能留下 loading，归 FPR-028） |
| Activity 显示 | 先同步 `document` 可见性，再 `start()`：立即重读并重建 1250ms 计时器 | 缓冲、模式、过滤、搜索与折叠开关保留 |
| `document` 隐藏 | `setDocumentVisible(false)`：取消在途读取；计时器保留但守卫跳过发送 | 已有行继续显示 |
| `document` 可见 | `setDocumentVisible(true)`：立即重读，之后按间隔轮询 | 不等待下一个 1250ms tick |
| 手动暂停 | `pause()`：取消在途读取，之后计时器 tick 全部跳过；暂停状态不被 Activity 或文档可见性变化清除 | 已有行继续显示 |
| 手动恢复 | `resume()`：立即重读一次，之后继续按间隔轮询 | 用最新快照替换暂停期间的旧快照 |
| 历史模式 | 页面调用 `stop()` 并清空实时缓冲；`enabled=false` 保证 Activity 恢复不会重新启动轮询 | 返回实时时 `start()` 立即重读 |
| 清空实时日志 | `pause()` → `POST /logs/recent/clear` → 成功后 `clear()` 本地缓冲 → `finally resume()` | 清空请求期间不发轮询；成功后立即重读服务端空快照 |
| 真正重挂载 / 浏览器刷新 | 新实例从空缓冲开始 | 过滤、搜索、折叠、历史选择与滚动状态全部重置 |

手动暂停已是流的公开动作（`useRealtimeLogs` 返回 `pause`/`resume`/`paused`），当前页面工具栏尚无独立暂停按钮；清空实时日志是现有调用方，FPR-035 负责把暂停交互接到工具栏并补充可访问性。

`enabled` 是页面级启用开关：历史浏览时为 `false`，Activity 恢复也不会启动轮询；重新为 `true` 时立即重读。它与手动暂停相互独立——手动暂停在关闭再开启页面级轮询后仍然有效。

## 5. 解析与显示模型

`logModel.ts` 保留迁移前的解析规则：

- 实时项优先解析 `message` 内的 MAA 历史行格式 `[日期 时间][级别][可选线程] 内容`；没有内嵌时间戳时使用信封的 `time`，无法解析的时间显示为空。
- 历史文件按非空行拆分；支持带毫秒、级别别名（`ERR`、`WRN`、`WARNING`、`TRC` 等）和旧格式 `[日期 时间 级别] 内容`。
- 无法识别的级别归为 `INFO`；缺少时间的行在摘要模式下丢弃，但在原始模式下保留。
- 摘要模式识别任务回调（开始/完成/失败、设备连接、分辨率、截图方式、仓库识别）、任务状态更新、MAA 命令开始/结束、stdout/stderr 与常见噪声行；`DEBUG`、JSON 行和无时间行不进入摘要。
- 级别过滤与搜索在摘要（或原始）结果之后应用；搜索不区分大小写，匹配时间、级别与消息。导出使用过滤后的行，不使用折叠后的行。
- 折叠只合并**连续**且级别与消息都相同的行，显示次数并使用最近一个非空时间；关闭折叠时每行次数为 1。
- 自动滚动是页面 Effect：仅在实时模式且开关打开时把容器滚到底部；历史模式强制关闭自动滚动。

## 6. 错误与兼容

- 信封失败优先使用 `message`/`errorInfo.message`/`error`，缺省为“实时日志请求失败”；抛出的异常使用其 `message`，缺省为“暂时无法获取实时日志”。
- 失败不改变实时 API 的函数签名、端点或响应形状；`getRealtimeLogs(lines?, signal?)` 继续由域 API 提供并传递 signal。
- 实时流没有进入 TanStack Query，不改变 Query 的默认重取、Activity 或窗口焦点策略；清空、历史读取与清理命令也不进入 Query。
- 本次不改变渲染结构、DOM 属性、CSS 或主题。页面隐藏、文档隐藏与暂停恢复只影响请求与缓冲，不改变已有行的展示格式。
- 回滚可以单独恢复页面内的计时器与请求守卫；服务端无需配合改动。

## 7. 回归证据

| 文件 | 覆盖 |
| --- | --- |
| `client/src/features/logs/model/logModel.test.ts` | 级别别名、时间格式、实时/历史解析、任务回调摘要、命令与噪声行、级别/搜索过滤、重复折叠、空输入 |
| `client/src/features/logs/model/realtimeLogStream.test.ts` | 200 行与 1250ms、慢请求不重叠、旧响应丢弃、失败保留缓冲、文档隐藏/可见、手动暂停粘性、停止/重启立即读取 |
| `client/src/features/logs/hooks/useRealtimeLogs.test.tsx` | 手动暂停跨可见性保持与恢复立即读取、`enabled` 启停、文档隐藏取消在途读取 |
| `client/src/features/logs/pages/LogViewer.activity.test.tsx` | Activity 隐藏停止并取消、显示立即重读、文档隐藏不发送、慢请求不叠加、清空期间暂停并在成功后立即重读 |
| `client/src/features/logs/pages/LogViewer.test.tsx` | 实时失败重试、后台刷新失败保留行、历史列表与文件重试 |
| `client/src/features/logs/api/index.test.ts` | 实时与历史读取的 signal、payload 校验、取消保持 `AbortError` |
