# 日志领域面板

> [← 返回文档索引](README.md)

本文说明日志页面组合、工具栏/列表/历史选择器边界与手动暂停接线。实时轮询、历史读取、清空/清理命令的所有者与协议均未改变；页面视图状态由工作区和受控面板持有；工具栏暂停入口与清空、历史、重试、Activity 协作的策略见下文。

相关契约：[实时日志流生命周期](logs-realtime-stream.md)、[历史日志与清理协调](logs-history-and-cleanup.md)、[前端架构与所有权](frontend-architecture.md)。

## 1. 定位与边界

| 内容 | 唯一归属 | 说明 |
| --- | --- | --- |
| 页面壳 | `pages/logs/LogViewer.tsx` | 只渲染 `app-page`/`app-stack-section`、页头、状态指示与工作区 |
| 跨面板视图状态 | `features/logs/components/LogsWorkspace.tsx` | 内容模式、级别、搜索、折叠、自动滚动、通知与确认动作；组合 `useLogsSession` |
| 摘要/原始模式分段 | `features/logs/components/LogContentModeTabs.tsx` | 受控 tab、流体高亮与方向键导航；测量跟随组件 |
| 工具栏 | `features/logs/components/LogsToolbar.tsx` | 自动滚动/折叠开关、级别、搜索、暂停、清空与导出入口 |
| 日志列表 | `features/logs/components/LogConsole.tsx` | 列表行、加载/失败/空态、选中历史文件信息与滚动容器 |
| 历史文件选择器 | `features/logs/components/HistoryLogPicker.tsx` | 文件列表、列表失败重试、当前选中与清理入口 |
| 命令结果提示 | `features/logs/components/LogNotice.tsx` | 成功 `status`、失败 `alert` 与关闭入口 |
| 实时/历史/命令状态 | `model/realtimeLogStream.ts`、`model/historyLogSession.ts`、`model/logCommands.ts` | 会话所有者，当前未改协议 |
| 解析/过滤/折叠视图 | `model/logModel.ts` 的 `buildLogView` | 纯函数；工作区只做一次派生，列表与导出共享结果 |
| 导出文本与文件名 | `model/logExport.ts` | 纯格式规则；Blob/objectURL/anchor 下载仍由工作区执行 |

非目标与保持不变：

- 不改变 `/agent/logs/*` 端点、`lines` 参数、1250ms 轮询、快照替换语义、历史请求序号与 AbortSignal 裁决。
- 不改变列表行结构、折叠规则、摘要识别、搜索匹配范围与导出格式（仍导出过滤后的折叠前行）。
- 不新增 Query、业务存储、cursor/offset 或跨标签页共享。
- 唯一有意的呈现变化是工具栏新增暂停/继续入口；`logs` 的 6 张默认态截图随之更新，其余 66 张基线不变（见 §6）。

## 2. 组合与状态边界

```
LogViewer（页面壳：PageHeader + FloatingStatusIndicator）
└─ LogsWorkspace（useLogsSession + 共享视图状态 + 导出动作）
   ├─ LogNotice（命令结果）
   ├─ LogContentModeTabs（摘要/原始）
   ├─ LogsToolbar（开关/级别/搜索/暂停/清空/导出）
   ├─ LogConsole（列表 + 自滚动容器）
   ├─ HistoryLogPicker（文件列表/选择/清理）
   └─ ConfirmDialog（清空/清理确认）
```

| 状态 | 所有者 | 进入历史 | 返回实时 | Activity 隐藏/恢复 | 真正卸载/刷新 |
| --- | --- | --- | --- | --- | --- |
| 实时缓冲、轮询计时器、错误、手动暂停 | `RealtimeLogStream`（页面实例） | `stop()` + `clear()`，暂停标记保留 | 恢复手动暂停后由 `enabled` 立即重读 | 计时器停止/重建；暂停标记保留 | 新实例，缓冲与暂停重置 |
| 历史文件列表、选择、读取相位与错误 | `HistoryLogSession` | 选中并读取 | 取消读取、清空选择 | 取消列表/读取，恢复重读列表并重试被取消的当前文件 | 全部重置 |
| 内容模式、级别、搜索、折叠 | `LogsWorkspace` 本地状态 | 保留 | 保留 | 保留 | 重置 |
| 自动滚动开关 | `LogsWorkspace` 本地状态 | 关闭并禁用 | 打开 | 保留 | 重置 |
| `scrollTop` Effect | `LogConsole` | 不执行 | 恢复执行 | Effect 清理/重建 | 随组件销毁 |
| 命令在途槽位 | `useLogsSession` | 清理入口禁用 | 保留 | 卸载取消本地等待 | 重置 |
| 通知与确认动作 | `LogsWorkspace` | 保留 | 保留 | 保留 | 重置 |
| 导出文本/文件名 | `model/logExport.ts` 纯函数 | — | — | — | — |

- **页面无会话与请求。** `LogViewer` 不调用日志 hooks/API，只组合工作区。
- **面板全部受控。** 工具栏、列表、历史选择器不订阅 `RealtimeLogStream`/`HistoryLogSession`，也不持有选择；所有回调与数据来自工作区。内容模式分段的测量、`ResizeObserver` 与键盘处理留在分段组件内。
- **自滚动靠近滚动容器。** 开关状态需要被工具栏与“进入/返回历史”共享，因此归工作区；`scrollTop` Effect 与 `ref` 归 `LogConsole`，只在实时模式且开关打开时滚到底部。
- **模式/过滤只派生一次。** 工作区的 `useMemo` 调用 `buildLogView`；列表使用 `visible`，导出使用 `filtered`，两者都来自同一快照，避免切换面板时重复摘要或折叠。

## 3. 暂停、清空与重试

工具栏暂停按钮只在实时模式渲染，点击调用 `RealtimeLogStream.pause()`/`resume()`；历史模式隐藏该按钮（历史读取不受暂停影响）。按钮可见文本在“暂停/继续”之间切换，可访问名称同步为“暂停实时日志/继续实时日志”，不使用与动作冲突的 `aria-pressed`。

| 交互 | 策略 | 依据 |
| --- | --- | --- |
| 手动暂停 | 取消在途读取，之后计时器 tick 跳过；Activity 与 `document` 可见性变化都不清除暂停 | `realtimeLogStream.ts` 既有语义 |
| 暂停后点“重新加载” | 先 `resume()` 再立即重读，不在暂停守卫上静默空转 | `LogsWorkspace.retryActiveLogs` |
| 暂停后清空 | 命令记录开始前的 `paused`；成功清空缓冲后仅当此前未暂停时 `resume()`，手动暂停保持 | `clearRealtimeLogsCommand` 的 `RealtimeLogCommandPort.paused` |
| 暂停 → 进入历史 → 返回实时 | `backToRealtime()` 先恢复暂停再退出历史；进入历史已清空缓冲，避免回到“已暂停且空缓冲” | `useLogsSession.backToRealtime` |
| 暂停且无日志 | 空态显示“实时日志已暂停，继续后重新读取” | `LogConsole` |
| 历史模式清理 | 保持禁用；清理成功后的 `reconcileSelection` 不会绕过页面的自动滚动恢复 | `HistoryLogPicker.cleanupDisabled` |

清空/清理失败、取消与卸载等待的裁决不变：失败保留缓冲/列表，确认弹层保持打开；页面卸载只取消本地等待，服务端已收到的动作不回滚。

## 4. 过滤、导出与自滚动

- 摘要/原始、级别、搜索与折叠仍由 `buildLogView` 依次应用；搜索不区分大小写，匹配时间、级别与消息。切换实时/历史、读取失败与重试不清空这些条件。
- 导出使用 `logView.filtered`（级别/搜索之后、折叠之前），每行 `[时间] [级别] 消息`；文件名 `maa-log-<UTC 日期>.txt` 与迁移前一致。格式与日期由 `model/logExport.ts` 固定，Blob/objectURL/anchor 的创建与撤销留在工作区；过滤结果为空时导出按钮禁用。
- 自动滚动默认开启；进入历史时关闭并禁用开关，返回实时时重新打开。开关重新打开会立即滚到底部；关闭后新日志追加不改变当前滚动位置。

## 5. Activity 与卸载

- Activity 隐藏/页面卸载：实时流 `stop()` 取消在途读取；历史会话取消列表与读取，进行中的读取转为 `cancelled`。工作区状态（模式、过滤、搜索、折叠、自动滚动、通知、确认动作）保留。
- Activity 显示：实时流按 `enabled` 与暂停标记决定是否立即重读；历史会话重读列表并重试被取消的当前文件。历史模式恢复不启动实时轮询。
- 浏览器刷新/真正重挂载：两个会话实例新建，缓冲、历史选择、过滤与滚动位置全部重置，与迁移前一致。

## 6. 兼容、视觉与回滚

- 端点、响应形状、轮询频率、请求取消、历史选择裁决、清空/清理命令端点与 `maxSizeMB:10` 均未变。
- 行为变化仅限本次接线所需的暂停策略：手动暂停时清空不再静默恢复轮询；从历史返回实时会恢复手动暂停。两者都有命令/页面级回归。
- 没有新增 CSS；DOM 结构除工具栏新增暂停按钮、暂停空态文案外与迁移前一致。暂停按钮是任务要求的可见交互，因此只更新 `logs` 的 6 张默认态截图（deep/light × desktop/tablet/mobile），其余页面基线不变；未通过放宽断言或删除测试取得通过。

## 7. 回归证据

| 文件 | 覆盖 |
| --- | --- |
| `pages/LogViewer.test.tsx` | 既有恢复/切换/清理回归；新增工具栏暂停与继续、暂停时错误重试先恢复、暂停后清空保持暂停、暂停→历史→返回实时立即重读、搜索过滤跨历史保持、导出过滤前重复行且过滤为空时禁用 |
| `pages/LogViewer.activity.test.tsx` | 既有 Activity/文档可见性、慢请求、清空与历史恢复；新增工具栏暂停停止轮询与恢复立即读取、手动暂停跨 Activity 隐藏/恢复保留 |
| `model/logCommands.test.ts` | 既有清空/清理次序；新增手动暂停时清空成功/失败都不自动恢复 |
| `model/logExport.test.ts` | 导出行格式、空选择与 UTC 文件名 |
| `model/logModel.test.ts`、`model/realtimeLogStream.test.ts`、`model/historyLogSession.test.ts`、`hooks/useRealtimeLogs.test.tsx`、`api/index.test.ts` | 既有解析/过滤/折叠、轮询与暂停、历史竞态、API signal 与载荷校验 |

针对性命令（实施仓库根目录）：

```sh
pnpm --filter la-pluma-next-client exec vitest run src/features/logs
```

真实浏览器验收在 Playwright Chromium（桌面视口）中以动态 `/api/agent/logs/*` 路由执行一次临时交互脚本，覆盖初始渲染与滚动到底、轮询追加、暂停后不再请求、继续立即读取、进入历史（暂停入口隐藏、清理禁用、自动滚动禁用）、返回实时、暂停后清空保持暂停、清理历史并刷新列表、搜索过滤、关闭自动滚动后新行不改变滚动位置、重新开启后回到底部；脚本验证后删除，不进入仓库。完整 `pnpm --filter la-pluma-next-client verify` 与 72 张视觉比对由任务工作流脚本执行，本文件不声称未执行的验证。

## 关联

- [实时日志流生命周期](logs-realtime-stream.md)：实时缓冲、轮询、暂停与解析模型。
- [历史日志与清理协调](logs-history-and-cleanup.md)：历史列表/读取竞态、清空/清理命令与选择裁决。
