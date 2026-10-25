# 前端职责与质量基线

本记录描述 `af3634d` 的实际前端行为，采集日期为 2026-10-25。下文的“目标所有者”用于后续迁移评审，尚未实现；现有缺陷不构成必须保留的兼容要求。

## 复现环境与质量门禁

Node 24.22.1、pnpm 12.6.0；宿主 Linux x86_64。视觉统一使用 `mcr.microsoft.com/playwright:v1.64.1-noble` 的 Chromium，时区 Asia/Shanghai、语言 zh-CN、DPR 1。仓库根执行：

```sh
pnpm verify
pnpm visual
pnpm --filter la-pluma-next-client stylelint:ratchet
```

| 检查 | 实际结果 |
| --- | --- |
| 客户端 lint / TypeScript / Vitest / 生产构建 | 通过；54 个测试文件，389 条测试；5 个 JS 产物均进入 SW precache |
| 服务端语法 / Node 测试 | 通过；48 个测试文件，277 条测试 |
| 视觉比对 | 72/72 通过，未更新截图 |
| 样式预算 | 通过；11 个文件共 825 条存量违规，未超预算 |

首次在受限沙箱运行根验证时，5 个服务端测试文件失败（本地监听及子进程能力受限）；在宿主所需权限下完整重跑后全部通过。这些结果不能登记成产品缺陷。初次 Docker 调用也需要本机 socket 权限。`verify` 的实际脚本没有执行样式预算，故单独运行。构建现有提示：入口 JS 505.68 kB（gzip 145.23 kB），超过 500 kB 提示阈值；它未导致构建失败。

机器可读结果见 [verification.json](evidence/frontend-baseline/verification.json)。测试运行时长受宿主并发影响，不作为性能对照。

## 视觉场景逐项核对

[visual-inventory.json](evidence/frontend-baseline/visual-inventory.json) 列出全部 72 张截图的文件、类别、视口、主题、场景、尺寸及 SHA-256。每个组合均由 `pnpm visual` 实际比对现有 PNG。

| 场景 | 桌面 1440×900 | 平板 820×1180 | 手机 390×844 | 合计 |
| --- | --- | --- | --- | --- |
| Dashboard / Automation / Combat / Roguelike / Training / Logs / Statistics / Settings | 每页深浅各 1 | 每页深浅各 1 | 每页深浅各 1 | 48 |
| Statistics 拥有状态菜单 / Training 干员选择弹层 / PWA 安装提示 | 每项深浅各 1 | 每项深浅各 1 | 每项深浅各 1 | 18 |
| HTML 启动壳（中止 React 入口加载） | 深浅各 1 | 深浅各 1 | 深浅各 1 | 6 |

`app.pw.ts` 用整页截图，弹层和启动壳用视口截图；固定时间为 2026-10-24 04:00（UTC+8），API 由 `fixtures.ts` 应答，远端图片和动效由 `harness.ts` 统一固定。弹层覆盖 portal 移出应用根后的材质与定位。820 视口覆盖无侧栏但保留内联页头的断点组合。源文件注释中仍有“32 张”的历史表述，实际配置及目录为 72 张。

性能采样随后捕获了共享 visual harness 在 documentElement 尚不存在时注入样式的早期 appendChild 异常；视觉用例未监听 pageerror，72/72 仅证明像素比对。性能入口独立记录该 setup 异常、导航后补注入冻结样式，测量窗口要求无异常；共享 harness 的初始化修复与补验留到综合验收。

这些默认态截图不覆盖执行中、断线、停止中、保存半失败等行为。结构搬移沿用同一 DOM/CSS 与像素基线；明确的缺陷修复以行为回归证明新结果；执行协议扩展以服务端契约和兼容验证验收。任何有意的可见变化须单列原因及前后证据，不能用批量更新截图消除未知差异。

## 路由与生命周期

`app/router/pages.ts` 注册八页；`AppRoutes` 归一 URL，`VisitedWorkspaces` 保留已访问页面并以 `Activity` 切换。URL 是导航事实来源，`Layout` 保存每个 tab 的滚动位置。Activity 隐藏保留 React 状态，清理 Effects，显示后重新运行 Effects；真正卸载/刷新会销毁页面状态。`usePageVisible` 只读取浏览器 `document.visibilityState`，不代表页面 tab 是否选中。

事件处理器已经发出的异步操作不会因 Effect 清理自动取消。跨页任务、配置写入与共享资源不能依靠页面挂载维持所有权。后续依赖仍遵守 `app → features → shared`；app 组装 Provider/控制器，业务协调留在对应 feature，shared 仅放传输与通用 UI。

## 八页职责矩阵

路径下文均相对 `client/src`；每页条目覆盖页面以及经 feature 根调用的业务能力。“资源域”表示未来独立于页面的唯一资源所有者；当前没有 Query 缓存或统一失效总线。UI 状态保留策略另列在生命周期表。

### Automation — `features/automation/pages/AutomationTasks.tsx`

| 职责 | 当前读写、入口与副作用 | 唯一目标所有者 |
| --- | --- | --- |
| 流程配置 | `loadTaskFlow` / `autoSave`：user-config `loadUserConfig/saveUserConfig('automation-tasks')`，GET/POST `/agent/config/user/automation-tasks`；pending 优先本地，否则服务端优先；revision、request id、AbortController 防迟到加载 | automation 配置适配器 + user-config 按 key 提交协调器 |
| 定时完整提交 | 保存配置后 `setupSchedule('default')` / `stopSchedule('default')`，POST `/agent/schedules`、DELETE `/agent/schedules/default`；本地保留禁用项；user-config 的 schedule 子对象发 enabled/times，setupSchedule 发 `{scheduleId,times,taskFlow}`；Promise 保存队列在页面 | 同一 automation 配置所有者管理配置与 schedule 两步确认 |
| 执行与停止 | `executeTaskFlow` → POST `/agent/schedules/manual/execute`；`stopTaskFlow` → POST `/agent/actions/stop`；每 1s GET `/agent/schedules/execution`；初始化 GET `/agent/tasks/status` 与 `/agent/activity?clientType=Official` | task-execution 应用级控制器 + automation 执行适配器；服务端 Run 持有流程 |
| 旧断点续跑 | `initializeAndRestore` 按旧 commandId 匹配 enabled 步骤，等后端 idle 后逐项 POST `/agent/actions/run-task`；1s 查询、30min 超时；启动/关闭/其他步间等待 15s/3s/2s；cleanup abort | 独立兼容迁移适配器；转换后仅观察身份，不重提 |
| 智能养成阶段 | `AutomationStageEditor.toggleSmartStages` 读取 `training-queue` 配置并 POST `/agent/training/plan`；监听 `training-plan-applied` 强制 load；document 可见时正常 load（已 hydrated 则跳过） | training 计划用例 + automation 配置冲突协调 |
| 连接测试 | POST `/agent/actions/test-connection`，带 signal；反馈至少 450ms | 设备连接用例 |
| 纯编辑与布局 | `buildCommand`、时间/排序/掉落规则在页内；picker 的 document pointerdown/keydown；排序 Escape、pointer capture；小屏 rAF `scrollIntoView` | 纯模型 + 最近的流程/编辑面板；布局副作用归布局 hook |

存储完整清单：`maa-task-flow`、`maa-schedule` 读写；`automationConfigSyncPending` 读写/成功删除；`maa-task-flow-execution` 初始化读取、逐步写入、完成/停止/提交失败删除（超时保留）。旧断点包含执行语义，不能和普通配置一起自动重放。领域草稿为 taskFlow/scheduleEntries/scheduleEnabled；picker/selectedTaskId/drag/撤销/公告/执行详情/连接反馈归局部 UI；running/stopping/currentStep/taskResults 是执行投影。

### Combat — `features/combat/pages/CombatTasks.tsx`

| 职责 | 当前读写、入口与副作用 | 唯一目标所有者 |
| --- | --- | --- |
| 配置 | GET/POST `/agent/config/user/combat-tasks`；仅 pending 时本地优先，否则服务端优先、失败用本地；坏 JSON 删除、app→cli 迁移；模块保存队列 + 页内 revision/token + 300ms debounce；手动重试 | combat 配置适配器 + 按 key 提交协调器 |
| 搜索 | GET `/agent/copilot/search?stage=…`、`/agent/paradox/search?name=…`；独立 request id 丢弃旧响应，但不取消网络 | combat 查询键/资源控制器；搜索词归面板 |
| 预览与作业集 | GET `/agent/copilots/:id`、`/agent/copilot-sets/:id`、`/agent/copilot-sets/:id/plan?raid=…`；plan 优先，失败 fallback set + 并发详情；completedModes/raid 恢复选择 | combat 查询/预览会话与纯 URI 模型 |
| 执行、进度与停止 | 单任务 POST `/agent/actions/run-task`，command 为 copilot/ssscopilot/paradoxcopilot，waitForCompletion=true；set POST `/agent/copilot-sets/:id/execute`；reset POST `…/:id/reset-progress`；兼容页内 sequential/manual 下一关；GET tasks/status 每 2s，三次失败警告；stop 后 400ms 查 idle，15s 超时 | task-execution 控制器 + combat 执行适配器；服务端拥有 set/manual 进度 |
| 命令与展示 | command/args/options 拼接；activeCombatMode/copilotType、搜索结果、预览、selected indexes、reset dialog、waitingForNext/current task/results | 纯命令模型；展示/选择归对应面板，执行结果只订阅 |

存储完整清单（均读写）：`combatTaskInputs`、`combatAdvancedParams`、`combatAutoFormation`、`combatCopilotSetExecutionMode`、`combatCopilotSetSelections`；`combatConfigSyncPending` 读写/成功删除。搜索/预览 generation、执行 generation 与 stop-wait AbortController 分别防迟到结果；没有独立后台运行身份。

### Roguelike — `features/roguelike/pages/RoguelikeTasks.tsx`

| 职责 | 当前读写、入口与副作用 | 唯一目标所有者 |
| --- | --- | --- |
| 配置 | GET/POST `/agent/config/user/roguelike-tasks`；`roguelikeTaskInputs`、`roguelikeAdvancedParams` 读写；`roguelikeConfigSyncPending` 读写/成功删除；坏 JSON 删除；模块队列 + 页内 revision/token + 300ms debounce | roguelike 配置适配器 + 按 key 提交协调器 |
| 命令 | `buildCommandParams` 字符串拼接；POST run-task，roguelike/reclamation、taskType=roguelike、waitForCompletion=true | roguelike 纯命令模型与执行适配器 |
| 观察/停止 | 挂载 GET tasks/status；同类运行每 2s 单飞查询、三次失败警告；stop 后 400ms 查 idle，15s 超时；cleanup abort、generation 失效 | 应用级 task-execution 控制器 |
| UI | activeMode、模式/高级字段、同步错误/重试、running/stopping | 模式/字段归面板；草稿归配置所有者，执行状态只订阅 |

### Dashboard — `features/dashboard/pages/Dashboard.tsx`

| 职责 | 当前读写、入口与副作用 | 唯一目标所有者 |
| --- | --- | --- |
| 完整业务快照 | `refreshDashboardData` 模块 single-flight；并发 GET `/agent/activity`、`/agent/schedules/execution`、`/agent/training/queue`、`/agent/drops/today`、`/agent/stages/open-today`；另 probe tasks/status；五业务响应全有效才替换；force 等在途后再补一次；每 5min 串行刷新，online 恢复 force | dashboard 快照协调器；共享资源唯一域，store 为受控投影 |
| 设备采样 | GET `/agent/device-stats`，立即 + 每 5s 单飞；失败保旧，与业务快照独立 | device telemetry 所有者 |
| 快捷命令 | `runTodayFlow` 读取 automation-tasks 后 POST `/agent/schedules/dashboard-quick-start/execute`；无配置导航 automation；`runCurrentActivity` POST `/agent/activity/run`；成功刷新，页内写全局 active/message | automation/task-execution 控制器；Dashboard 保留操作反馈 |
| 缓存 | `dashboard/store/dashboardStore.ts` 管 `la-pluma-dashboard-cache` v1 读写/重置删除；验 shape、未来偏差 60s；仅完整快照持久化（夹带设备值/历史），独立采样不写存储；最多 36 温度样本 | dashboard 快照 store |
| UI/布局/预览 | quickStartLoading、activityPreflightLoading、消息；`useDashboardFlowLayout` matchMedia(1280)、ResizeObserver、window resize、rAF；`useDashboardPreview` 预览会话 | 局部反馈与布局 hook；预览归 device-mirror 会话 |

### Statistics — `features/statistics/pages/DataStatistics.tsx`

| 职责 | 当前读写、入口与副作用 | 唯一目标所有者 |
| --- | --- | --- |
| 四类读取 | `loadDepotData/loadOperBoxData/loadAllOperators/loadDropData`：GET `/agent/data/depot`、`/agent/data/operbox`、经 training 的 `/agent/data/operators`、`/agent/drops/statistics?days=…`；独立 request id，cleanup 失效，无网络 abort | depot/持有干员/目录资源域；statistics 掉落查询 |
| 识别命令 | `executeDepot/executeOperBox` POST run-task，Depot/OperBox，waitForCompletion=true；不可取消的 2s 等待后 POST `/agent/actions/depot-recognition` 或 `/operbox-recognition`；仓库解析后查 queue 只选提示 | statistics 识别用例 + task-execution 控制器 + 跨域失效 |
| 材料获取/图片 | POST `/agent/actions/fetch-training-materials`，仅重读 allOperators；getItemIconUrl 生成 GitHub raw URL | 资源更新用例及图标元数据所有者 |
| UI | activeTab、六项筛选/排序、openMenu、图片加载/失败、dropDays、四区 loading/error、activeTask；FilterMenu document pointerdown/focusin/keydown、window resize/捕获 scroll | 最近的统计面板/筛选模型；命令状态订阅执行所有者 |

无业务 localStorage。识别只刷新本页，尚未刷新训练候选/计数/材料和总览；材料下载也只刷新本页目录。识别事件处理器在 Activity hidden 后仍可能继续完成。

### Training — `features/training/pages/OperatorTraining.tsx`

| 职责 | 当前读写、入口与副作用 | 唯一目标所有者 |
| --- | --- | --- |
| 候选与计数 | GET `/agent/training/operators`（status/rarity/needsElite2）；all 空时 fallback allOperators + statistics 的 operBox；计数并发 trainable/owned 两次 operators + allOperators + operBox | training 候选/计数查询；共享目录/持有干员归资源域 |
| 队列写入 | GET `/agent/training/queue`（含 settings/revision/flowSync）；POST queue、DELETE queue/:id、PUT queue/order，随后重读；失败保可解释本地 fallback；beginMutation 防重入/废弃旧计划 | training 队列 mutation 用例和唯一 queue 资源 |
| 设置 | PUT `/agent/training/settings`；页内 ref Promise 队列串行，只对最新失败回滚 persistedSettings；设置成功当前未主动清 plan | training 设置提交/计划有效期所有者 |
| 计划 | generate 前重读 queue，POST `/agent/training/plan`，拒绝 queueRevision 不符；POST `/agent/actions/apply-training-plan` 仅应用当日开放关；失败清计划并重读；POST `/agent/training/sync` 后重读 | training 计划版本、生成/应用/同步用例 |
| 通知 | `recordSync` 对 synced 派发 `training-plan-applied`，当前无 detail；automation 强制 load 并尝试读 stageCount（当前为 0） | 领域失效协议 + automation 配置冲突协调 |
| UI | filters/search、selectorOpen、planMode、render limit=72、图片、pending ids、busy/error；UndoToast 8s，hover/focus/pending 暂停，cleanup 清 timer | 最近面板；撤销意图归队列用例、toast 呈现归组件 |

无业务 localStorage；queue/settings/plan 当前完整保存在页面。候选/计数/queue 有 request id，但没有 AbortController 或 Effect cleanup 递增失效。没有外部 depot/operbox/material/resource 更新订阅；真正 remount 会丢失页内写队列所有权，旧 async 仍可能继续。

### Settings — `features/settings/pages/ConfigManager.tsx`

| 职责 | 当前读写、入口与副作用 | 唯一目标所有者 |
| --- | --- | --- |
| 配置读取/草稿/保存 | 初始化并发 GET `/agent/config-directory`、`/agent/config/maa/default`、user config `auto-update`、`/agent/version`；POST maa/default，wire `{connection: snapshot}`；revision 防初载盖编辑，并避免把旧保存误报成当前编辑已保存 | settings 配置编辑与持久化所有者 |
| 自动更新 | POST user config auto-update 后 POST `/agent/actions/configure-auto-update`，两步成功才清 dirty；Touched/revision 防迟到加载/确认 | settings 完整提交适配器 |
| 设备与连接 | GET `/agent/actions/discover-devices?adbPath=…`；POST `/agent/actions/test-connection`；页面未传 API 支持的 signal；POST `/agent/actions/open-config-directory` | 设备发现/连接测试用例 |
| 版本/更新 | POST `/agent/actions/update-core`（普通更新不传 version，切渠道传 stable/beta）、`/agent/actions/update-cli`、`/agent/actions/hot-update-resources`；共用 updateInFlightRef 互斥；成功仅 reloadVersion | 更新用例与显式资源失效；版本/目录归资源域 |
| 存储与 UI | `laPlumaConfigSection` 读写；`autoUpdateConfig` 成功加载/每次编辑/保存后写，服务端加载失败时读作 fallback；window `la-pluma-config-section` 监听/清理；section、设备列表/选中、busy/error | section 归设置面板；自动更新本地 fallback 归配置适配器 |

无页面 timer。`autoUpdateConfig` 本地已写不代表调度已应用。core/cli/资源更新尚不刷新目录、图标、候选/计数、计划及总览。

### Logs — `features/logs/pages/LogViewer.tsx`

| 职责 | 当前读写、入口与副作用 | 唯一目标所有者 |
| --- | --- | --- |
| 实时会话 | GET `/agent/logs/recent?lines=200`，每 1250ms HTTP 轮询，AbortSignal + mounted/request id/paused 防竞态；每次替换最近 200 行，不是追加流 | logs 实时会话所有者 |
| 历史查询 | GET `/agent/logs/files`；GET `/agent/logs/files/{encodedPath}?lines=1000`；历史文件 request id 防切换覆盖；文件列表无请求序号 | logs 历史查询协调器 |
| 清空/清理 | POST `/agent/logs/recent/clear` 前暂停/abort，成功清本地，finally 恢复；POST `/agent/logs/cleanup` `{maxSizeMB:10}` 后重读列表 | logs 清理用例与实时/历史协调 |
| 模型/展示 | parseHistoryLine/parseRealtimeLog/summarizeLog、折叠/过滤；summary/raw、level/search/collapse、autoScroll、history selection/mode、confirm/notice；scrollTop Effect；导出 Blob/objectURL/anchor，随后 revoke | 纯日志模型与最近面板；缓冲归会话 |

无业务存储，无 WebSocket/EventSource。历史请求在 Activity hidden 时完成会被 mounted guard 丢弃，finally 也不清 loading；restore 不自动重试当前历史文件，存在卡 loading 缺口。清理 handler 没有卸载取消。

## 共同副作用与状态生命期

`FloatingStatusIndicator` 经 runtime-status 订阅全局 active/message 与 online/offline；`operator-quotes` 发 GET `/operator-quotes/random`，模块级去重/缓存。statusStore 的消息消失计时器：success 1.5s、warning/default 3s、info 10s，error 不自动消失。当前页面与监测器仍直接写共享 statusStore；目标是 runtime-status 消费唯一运行快照以派生连接健康和全局展示；operator-quotes 自管只读缓存。

应用级 `runtime-status/hooks/useBackendStatusMonitor` 独立 GET `/agent/tasks/status`：空闲每 30s、active 每 2s 串行 timeout；监听 online/offline/focus 与 statusStore 订阅，offline/cleanup abort 并使 revision 失效。成功同时写 backendStatus 和 isActive，因此当前仍可能与页面执行投影争写。连接监测归 runtime-status；运行身份的唯一所有者仍是待实现的 Run/执行控制器。

调用 `useFluidTabIndicator` 的页面使用 ResizeObserver、window resize 与测量，cleanup 撤销。Automation 的 `NotificationSettings` 当前直接使用 fetchWithAuth 调 GET/POST `/agent/notifications/config` 与 POST `/agent/actions/test-notification-channel`；模块 cache/pending 去重，草稿无 localStorage；revision 防载入盖编辑，cleanup abort 保存/测试并在恢复清 loading。目标由 notification 服务管理 API/cache，控制器管理草稿/保存/测试；独立于流程配置。Automation/Combat/Roguelike 及 Dashboard 使用 device-mirror 预览（见该域公开面和 `useDashboardPreview`），每实例会话/全局偏好、截图与 WebRTC 信令由 device-mirror 管理，按实际 tab/文档可见性暂停，不能归入运行停止语义。

预览的完整边界（均唯一归 device-mirror，页面仅消费公开面）：

- `ScreenMonitor` 挂载/恢复 GET `/agent/webrtc/status`；非 live 且 agentRunning、文档可见时 4s/18s 延后复查。POST `/agent/webrtc/install`、`/agent/webrtc/start-server`、`/agent/webrtc/stop-server`、`/agent/webrtc/start-agent`、`/agent/webrtc/stop-agent` 及组合 `/agent/webrtc/start` 控制基础设施；关闭前置 mode=off，revision/cleanup 防迟到结果。
- `usePreviewSession` 在 live + document visible + automation available 才启动，45s deadline；清理 abort、disconnect、撤 timer。`usePreviewSnapshot` 在 snapshot + 可见 + 可用时 POST `/agent/screen/screenshot`，每次完成后 10s 再读，单次 20s deadline，隐藏清画面并取消。
- `preview-storage` v1 读写 mode/autoStart/quality/fps/maxSize/bitrate；刷新仅 autoStart=true 恢复 mode，否则 off。`scrcpy_webrtc_auth_token` 在每次登录前删除、成功写入、失败删除，不复用旧值（文档与证据不记录 token 值）。
- `useScrcpyWebRTC` POST 同源 gateway `/webrtc-signaling/api/login`（外部信令分支使用 `<httpBase>/api/login`），创建 WebSocket/RTCPeerConnection/DataChannel，处理 offer/answer/ICE/视频/触控；重试 300/800ms，单次 4s、信令 12s、媒体 20s、ICE gathering 2s deadline，每秒 getStats；cleanup 拆 transport/timers/listeners。
- `ScrcpyDeviceView` 的触控 pointer capture/rAF、沉浸 portal/history/popstate/keydown/focus trap/body overflow/inert/aria-hidden/video stream 都由预览组件清理和恢复；UI mode/controls/settingsDirty 保留于 Activity。布局仍有页面自持 639/640、767/768、899/900、1024、1200、1280、1360 等边界，纯结构迁移不静默合并断点。

| 页面 | Activity hide / show | document hidden | 真正 remount / 浏览器刷新 |
| --- | --- | --- | --- |
| Automation | 保留草稿/选择/撤销/结果；清 polling/监听/兼容 runner/连接测试；show 清 loading、查状态，已 hydrated 不重载配置 | 业务查询继续；预览暂停 | 重读本地/服务端与旧断点；旧续跑当前可能重提，未来改观察恢复 |
| Combat | 保留草稿/UI；失效 search/preview generation，abort status/stop 等待；show 清中断 loading、查运行，不重载配置 | 业务查询继续；预览暂停 | 恢复配置/后端 running，manual 当前集/结果不恢复 |
| Roguelike | 保留草稿/模式；清 status/stop 等待；show 查运行、跳过已 hydrated 配置 | 业务查询继续；预览暂停 | 配置/后端恢复，activeMode 回默认 |
| Dashboard | 停 5s/5min timers；在途业务 promise 仍可落 store；show 按时戳刷新并立即采设备 | 业务/设备 timer 继续，预览暂停 | store/模块在普通 remount 存活；刷新读完整 local cache |
| Statistics | 保留筛选/UI；失效读取；show 重读四类资源 | 无专门处理 | 所有局部状态重置 |
| Training | 保留 state/ref 写队列；在途读写继续；show 重读 queue/候选/计数、render limit 回 72；撤销计时重新计 8s | 无专门处理 | 丢失页面写队列，未完成 closure 不会自动取消 |
| Settings | didInitializeRef 阻止重复初始化；重建 section 监听；在途操作继续 | 无专门处理 | section/autoUpdate fallback 可恢复，其余重新初始化 |
| Logs | 停 interval/监听并 abort realtime；show 重建，刷新文件列表及实时（历史模式不重读当前文件） | interval 保留但 guard 不发请求，abort 实时；可见立即取数 | 缓冲/选择/过滤全部重置 |

## 性能对照入口与待验收边界

四类交互的固定数据、步骤、采样、浏览器指标和网络请求见[性能采样说明](evidence/frontend-baseline/performance.md)。它们测量浏览器工作与 DOM 更新；普通生产包没有 React profiling，不能把 DOM mutation 当作 React commit 次数。后续必须在同一构建方式/数据量/设备采样，真实大队列与 React Profiler 的补测条件在说明中登记。

尚待实现的边界包括：所有旧执行入口纳入 Run、manual lease 释放/重获、跨 remount 配置写入次序、automation schedule 半失败、应用计划与 pending 草稿冲突、共享资源去环与失效、训练设置改变后的计划有效期、历史日志隐藏恢复。后续契约与表征工作需要给出对应回归清单；不以当前截图通过推断这些条件已经满足。配置提交差异、迟到加载、跨页失效与 Dashboard 快照的实际表征见[配置同步与资源一致性契约](config-sync-and-invalidation.md)。

实际拖拽采样发现：指针移动引起重排后发生 lostpointercapture，当前处理器取消排序并还原原序，没有配置写入。性能文件记录真实路径和结果；这组数据不能冒充成功排序的耗时。成功排序须在自动化流程面板处理捕获生命周期后补测，并在最终性能对照时重采。它属于明确缺陷修复边界，现有取消行为不作为保留要求。
