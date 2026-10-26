# 前端职责与质量基线

本记录描述 `af3634d` 的实际前端行为，采集日期为 2026-10-25。下文的“目标所有者”用于后续迁移评审，尚未实现；现有缺陷不构成必须保留的兼容要求。

本页在迁移过程中追加过各域进展，包含历史行为与实施时说明。维护当前代码请以[前端架构与所有权](frontend-architecture.md)、[迁移与兼容审计](frontend-migration.md)和[最终质量基线](frontend-final-baseline.md)为准；原始性能 JSON 与说明保留原样，新的双侧 profiling 和普通生产后测见[最终性能证据](evidence/frontend-final/performance.md)。

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

事件处理器已经发出的异步操作不会因 Effect 清理自动取消。跨页任务、配置写入与共享资源不能依靠页面挂载维持所有权。后续依赖遵守 `app → pages → features → shared`；app 组装 Provider/控制器，pages 只组合页头与领域工作区，业务协调留在对应 feature，shared 仅放传输与通用 UI。

## 八页职责矩阵

路径下文均相对 `client/src`；每页条目覆盖页面以及经 feature 根调用的业务能力。“资源域”表示未来独立于页面的唯一资源所有者；本基线采集时没有 Query 缓存或统一失效总线，FPR-017 已补应用级 Query 基础设施，页面读取迁移仍由后续任务完成（见 [Query 缓存与键规范](query-cache.md)）。FPR-018 已把仓库、持有干员与干员目录的读取归属迁到 `features/game-data`，并交付跨域失效端口；下表“当前”列仍描述 `af3634d` 基线，最新归属与失效契约见[共享资源归属与失效端口](resource-ownership.md)。UI 状态保留策略另列在生命周期表。

### Automation — `pages/automation/AutomationTasks.tsx`

| 职责 | 当前读写、入口与副作用 | 唯一目标所有者 |
| --- | --- | --- |
| 流程配置 | 适配器 `features/automation/model/automationConfig.ts` 经 `features/user-config` 协调器读写 GET/POST `/agent/config/user/automation-tasks`；本地键与 `automationConfigSyncPending` 不变；坏 JSON 清理、pending 本地优先、`entries`/`times` 兼容与任务参数迁移、编辑即入队与跨 remount 串行队列由通道持有；页面只订阅 `draft`/`error`/`syncState` 并调用 `retry()` | automation 配置适配器 + user-config 按 key 提交协调器（FPR-015 已接入） |
| 定时完整提交 | 同一适配器在配置保存后 `setupSchedule('default')` / `stopSchedule('default')`，POST `/agent/schedules`、DELETE `/agent/schedules/default`；禁用项只留在本地 `maa-schedule.entries`；user-config 的 schedule 子对象发 enabled/times，setupSchedule 发 `{scheduleId,times,taskFlow}`；两步全成功才清 pending，半失败可用页内“重新同步”重跑 | 同一 automation 配置所有者管理配置与 schedule 两步确认 |
| 执行与停止 | `executeTaskFlow` → POST `/agent/schedules/manual/execute`；`stopTaskFlow` → POST `/agent/actions/stop`；每 1s GET `/agent/schedules/execution`；初始化 GET `/agent/tasks/status` 与 `/agent/activity?clientType=Official` | task-execution 应用级控制器 + automation 执行适配器；服务端 Run 持有流程 |
| 旧断点续跑 | `initializeAndRestore` 按旧 commandId 匹配 enabled 步骤，等后端 idle 后逐项 POST `/agent/actions/run-task`；1s 查询、30min 超时；启动/关闭/其他步间等待 15s/3s/2s；cleanup abort | 独立兼容迁移适配器；转换后仅观察身份，不重提 |
| 智能养成阶段 | `AutomationStageEditor.toggleSmartStages` 读取 `training-queue` 配置并 POST `/agent/training/plan`；订阅 `automation-config`/`automation-schedule` 失效后先 `flush()` 配置通道再 `reload({ force: true })`；有 pending 草稿时保留本地并提示，否则采用服务端副本并保留本地禁用时间点；document 可见时正常 load（已 hydrated 则跳过） | training 计划用例 + automation 配置冲突协调 |
| 连接测试 | POST `/agent/actions/test-connection`，带 signal；反馈至少 450ms | 设备连接用例 |
| 纯编辑与布局 | 定时时间、任务命令（添加/恢复/参数/执行前校验）、拖拽排序与掉落目标解析已由 `features/automation/model/automationSchedule.ts`、`taskFlowCommands.ts`、`taskFlowSort.ts`、`dropTargets.ts` 持有；关卡列表编辑与智能养成合成由 `model/stageEditing.ts` 持有，公招时长校验由 `model/taskParamRules.ts` 持有；FPR-039 起逐项执行状态与摘要来源由 `model/flowExecution.ts` 持有；`components/AutomationStageEditor.tsx` 持有智能养成在途标记并调用 training 读取/计划，`components/AutomationTaskPicker.tsx` 持有菜单开关、document pointerdown/keydown 与 Escape 回焦；排序预览、document pointer 生命周期与 Escape 由 `hooks/useTaskFlowSorting.ts` 持有；页面只组合 `components/AutomationWorkspace.tsx`，流程/定时/摘要分别在 `AutomationTaskFlowPanel`、`AutomationSchedulePanel`、`AutomationExecutionSummary`；小屏 rAF `scrollIntoView` 仍在工作区 | 纯模型 + 最近的流程/编辑面板；布局副作用归布局 hook（FPR-037/038/039） |

存储完整清单：`maa-task-flow`、`maa-schedule` 读写；`automationConfigSyncPending` 读写/成功删除；`maa-task-flow-execution` 初始化读取、逐步写入、完成/停止/提交失败删除（超时保留）。旧断点包含执行语义，不能和普通配置一起自动重放。领域草稿为协调器中的 taskFlow/schedule；picker 开关与焦点归 `AutomationTaskPicker`，selectedTaskId/撤销/连接反馈归 `AutomationWorkspace`，拖拽预览/公告归 `useTaskFlowSorting`，执行详情归 `AutomationExecutionSummary`；running/stopping/currentStep/taskResults 是执行投影；当前活动由 `automation/activity` Query 展示（FPR-039）。

### Combat — `pages/combat/CombatTasks.tsx`

| 职责 | 当前读写、入口与副作用 | 唯一目标所有者 |
| --- | --- | --- |
| 配置 | 适配器 `features/combat/model/combatConfig.ts` 经 `features/user-config` 协调器读写 GET/POST `/agent/config/user/combat-tasks`；本地键与 `combatConfigSyncPending` 不变；坏 JSON 清理、pending 本地优先、`app→cli` 与 raid `1`/`2` 迁移、300ms 去抖与跨 remount 提交队列由通道持有；页面只订阅 `draft`/`error`/`syncState` 并调用 `retry()` | combat 配置适配器 + 按 key 提交协调器（FPR-014 已接入） |
| 搜索 | GET `/agent/copilot/search?stage=…`、`/agent/paradox/search?name=…`；FPR-029 起由 `combat` 域 Query 持有（`copilot-search`/`paradox-search`），显式搜索 `staleTime: 0`，输入变化/Activity 隐藏 `cancelQueries` 并真正中止 fetch，旧响应只写旧 key | combat 查询键/资源控制器；搜索词与搜索选中项归搜索面板的会话存储，工作区不订阅（FPR-036） |
| 预览与作业集 | GET `/agent/copilots/:id`、`/agent/copilot-sets/:id`、`/agent/copilot-sets/:id/plan?raid=…`；计划优先，失败 fallback set + 并发详情；`CopilotPreviewSession` 裁决旧响应、Activity 取消与终态强制刷新；completedModes/raid 恢复选择 | combat 查询/预览会话与纯 URI 模型（FPR-029 已交付） |
| 执行、进度与停止 | 单任务 POST `/agent/actions/run-task`，command 为 copilot/ssscopilot/paradoxcopilot，waitForCompletion=true；set POST `/agent/copilot-sets/:id/execute`；reset POST `…/:id/reset-progress`；兼容页内 sequential/manual 下一关；GET tasks/status 每 2s，三次失败警告；stop 后 400ms 查 idle，15s 超时 | task-execution 控制器 + combat 执行适配器；服务端拥有 set/manual 进度 |
| 命令与展示 | command/args/options 拼接由 `model/combatCommands.ts` 持有；FPR-036 后 `pages/CombatTasks.tsx` 只组合页头与工作区，`components/CombatWorkspace.tsx` 持有 activeCombatMode、配置订阅、预览/搜索入口、执行订阅、selected indexes 与重置弹层，设置/输入/搜索/作业集/信息面板只接收投影；搜索词、识别方式与搜索选中项由面板会话存储隔离 | 纯命令模型；展示/选择归对应面板，执行结果只订阅（FPR-036） |

存储完整清单（均读写）：`combatTaskInputs`、`combatAdvancedParams`、`combatAutoFormation`、`combatCopilotSetExecutionMode`、`combatCopilotSetSelections`；`combatConfigSyncPending` 读写/成功删除。FPR-029 后搜索/预览由 Query 观察者与 `CopilotPreviewSession` 的请求代次裁决，执行仍由控制器 generation/stop-wait 裁决；没有独立后台运行身份。FPR-036 后页面壳只组合工作区，搜索词、识别方式与搜索选中项是面板会话状态，不写入上述存储。

### Roguelike — `pages/roguelike/RoguelikeTasks.tsx`

| 职责 | 当前读写、入口与副作用 | 唯一目标所有者 |
| --- | --- | --- |
| 配置 | 适配器 `features/roguelike/model/roguelikeConfig.ts` 经 `features/user-config` 协调器读写 GET/POST `/agent/config/user/roguelike-tasks`；本地键 `roguelikeTaskInputs`、`roguelikeAdvancedParams` 与 `roguelikeConfigSyncPending` 不变；坏 JSON 清理、pending 本地优先、300ms 去抖与跨 remount 提交队列由通道持有；工作区只订阅 `draft`/`error`/`syncState` 并调用 `retry()` | roguelike 配置适配器 + 按 key 提交协调器（FPR-013 已接入） |
| 命令 | `features/roguelike/model/roguelikeTasks.ts` 持有任务目录、主题快捷项、高级选项、命令拼接与输入校验；执行 hook 提交 POST run-task，roguelike/reclamation、taskType=roguelike、waitForCompletion=true | roguelike 纯命令模型（FPR-031）与执行适配器 |
| 观察/停止 | `features/roguelike/hooks/useRoguelikeExecution.ts` 订阅 `task-execution` 控制器快照；提交/停止按本客户端持有的 runId，停止确认 15s 超时解锁；页面隐藏/卸载不停止 run | 应用级 task-execution 控制器（FPR-008 已接入） |
| UI | `pages/RoguelikeTasks.tsx` 只组合页头与工作区；`components/RoguelikeWorkspace.tsx` 持有 activeMode、配置订阅、同步错误/重试与执行订阅；`RoguelikeModePanel` 负责分段控件测量/键盘，主题与策略面板只渲染草稿并回调；running/stopping 来自控制器 | 模式/字段归面板；草稿归配置所有者，执行状态只订阅（FPR-031） |

### Dashboard — `pages/dashboard/Dashboard.tsx`

| 职责 | 当前读写、入口与副作用 | 唯一目标所有者 |
| --- | --- | --- |
| 完整业务快照 | `model/queries.ts` 组合 `automation/activity`、`automation/schedule-execution`、`training/queue`、`statistics/today-drops`、`statistics/open-stages` 五路 Query（协调读取显式 `staleTime: 0`/不自动重试），`model/snapshot.ts` 纯归一；`model/snapshotRefresher.ts` 模块 single-flight，force 等在途后再补一次，五路全有效才原子提交；后端探针不否决快照；`hooks/useDashboardSnapshotRefresh.ts` 每 5min 串行刷新、online 恢复与 `dashboard-snapshot` 失效 force 刷新 | dashboard 快照协调器与纯模型；五路资源归各自领域 Query，store 为受控投影（FPR-030） |
| 设备采样 | `device-mirror` 的 `deviceStatsQueryOptions` + `useDeviceStatsSample`：`device-stats` Query 每 5s 轮询、立即采样、失败静默保旧、`retry: false`；`useDashboardDeviceStats` 把成功样本交给 store 校验并追加温度历史，同一 `dataUpdatedAt` 的缓存回放不重复追加（FPR-040）；Activity 隐藏注销观察者与计时器，恢复立即采样一次 | device-mirror 采样所有者；总览只做投影（FPR-030/040） |
| 快捷命令 | `runTodayFlow` 读取 automation-tasks 后 POST `/agent/schedules/dashboard-quick-start/execute`；无配置导航 automation；`runCurrentActivity` POST `/agent/activity/run`；成功刷新，页内写全局 active/message | automation/task-execution 控制器；Dashboard 保留操作反馈 |
| 缓存 | `dashboard/store/dashboardStore.ts` 管 `la-pluma-dashboard-cache` v1 读写/重置删除；验 shape、未来偏差 60s；仅完整快照持久化（夹带设备值/历史），独立采样不写存储；最多 36 温度样本；`dashboard/snapshot` 协调读取 `gcTime: 0`，不长期保留第二份快照 | dashboard 快照 store |
| UI/布局/预览 | FPR-040 起页面只组合 `DashboardWorkspace`：连接提示、流程/预览、设备状态与摘要分别在 `DashboardConnectionAlert`、`DashboardFlowSection`（含 `DashboardFlowPanel`）、`DashboardDeviceSection`、`DashboardSummarySection`（两张摘要卡）；预检/启动 loading 与反馈留在流程卡，命令文案与设备曲线由 `model/flowView.ts`/`model/deviceView.ts` 纯派生；`useDashboardFlowLayout` matchMedia(1280)、ResizeObserver、window resize、rAF；`useDashboardPreview` 预览会话 | 局部反馈与布局 hook；预览归 device-mirror 会话（FPR-040） |

### Statistics — `pages/statistics/DataStatistics.tsx`

| 职责 | 当前读写、入口与副作用 | 唯一目标所有者 |
| --- | --- | --- |
| 四类读取 | 四路领域 query：`depotQueryOptions`、`operBoxQueryOptions`、`operatorCatalogQueryOptions`、`dropStatisticsQueryOptions(days)`；分别由 `DepotPanel`、`OperatorPanel`（两路）、`DropPanel` 持有观察者，面板常驻保证首屏并行，按作用域失效，Query 负责 signal/竞态/失败重试 | depot/持有干员/目录资源域；statistics 掉落查询（FPR-019/FPR-032） |
| 识别命令 | `statisticsCommandOwner.run('depot'/'operbox')`：控制器 intent + run-task（Depot/OperBox，waitForCompletion=true）；解析端点轮询到可用快照；超时/取消后继续等待或复用同一幂等键，不重新执行设备命令；`hooks/useStatisticsCommands.ts` 在工作区订阅一次并写回解析快照 | statistics 命令所有者 + task-execution 控制器 |
| 材料获取/图片 | `statisticsCommandOwner.run('materials')` 调 training 的 POST `/agent/actions/fetch-training-materials`，成功发布 `materials`/`training-queue`/`dashboard-snapshot`；getItemIconUrl 生成带缓存 epoch 的 GitHub raw URL，资源更新成功后推进 epoch | 命令所有者；图标元数据所有者 |
| 跨域失效 | 识别解析成功发布 `depot` 或 `operbox` + `materials`/`training-queue`/`dashboard-snapshot`；`useStatisticsCommands` 把解析快照写入 Query；材料刷新不重读目录；`StatisticsWorkspace` 按作用域失效四路 key | `features/resource-invalidation` 端口 |
| UI | `pages/DataStatistics.tsx` 只组合页头与工作区；`StatisticsWorkspace` 持有 activeTab、命令投影与失效订阅；`OperatorPanel` 持有筛选/排序、openMenu 与头像加载缓存，`DepotPanel` 持有失败图标与汇总展示，`DropPanel` 持有统计周期；`FilterMenu` 持有 portal 定位、document pointerdown/focusin/keydown 与 window resize/捕获 scroll；`DropRecords` 只渲染视图，材料/关卡排序由 `model/dropRecords` 提供 | 最近的统计面板/筛选模型；命令状态归 statistics 命令所有者（FPR-032） |

无业务 localStorage（执行控制器持久化的是 Run 身份，不属于本页）。命令所有者是模块级单例，识别在 Activity hidden 后仍会继续完成并写入 Query 快照；重新显示时按失效 revision 补一次读取。

### Training — `pages/training/OperatorTraining.tsx`

| 职责 | 当前读写、入口与副作用 | 唯一目标所有者 |
| --- | --- | --- |
| 候选与计数 | `trainingCandidatesQueryOptions`（GET `/agent/training/operators`，status/rarity/needsElite2；all 空时在查询内用 `game-data` 目录 + 持有干员补齐）；`trainingStatusCountsQueryOptions` 并发 trainable/owned 端点与目录/持有快照；页面只读取 query 结果，失败语义见 `docs/query-cache.md` 第 10 节 | training 候选/计数查询；共享目录/持有干员归 `game-data` 公开端点 |
| 队列 | `trainingQueueQueryOptions` 读取 GET `/agent/training/queue`（含 settings/revision/flowSync）；增删/排序/撤销由 `model/queueCommands.ts` 串行命令执行，写成功后重读权威队列并写入同一 `training/queue` key，失败保可解释 fallback 并标记 `uncertain`；命令发布 `training-queue`/`materials`/`training-plan`/`dashboard-snapshot`，流程确认 synced 时额外发布 `automation-config` | training 队列 query、串行命令与唯一 queue 资源（FPR-021/023） |
| 设置 | PUT `/agent/training/settings`；FPR-022 起由 `model/settingsCommands.ts` 的模块级所有者串行提交，只有最新响应能改变页面值，失败回滚到最近确认值；设置 revision 与队列 revision 共同决定计划是否可应用 | training 设置提交/计划有效期所有者（FPR-022 已接入） |
| 计划 | `model/planCommands.ts` 的 `TrainingPlanOwner`：生成前重读 queue，冻结队列/设置版本，POST `/agent/training/plan`，拒绝 queueRevision 不符与生成期间版本变化；队列或设置版本变化、刷新失败时禁用生成/应用；应用前经配置协调器排空 automation 在途保存，POST `/agent/actions/apply-training-plan` 仅应用当日开放关，随后发布 automation/schedule/总览失效并重读；schedule 注册失败或重读失败为部分成功，保留计划并给重试入口；`POST /agent/training/sync` 后重读 | training 计划版本、生成/应用/同步用例（FPR-023） |
| 通知 | 显式应用成功后由所有者发布 `automation-config`/`automation-schedule`/`dashboard-snapshot`；队列写入/重试同步只发布 `automation-config`/`dashboard-snapshot`（自动同步不重注册 cron）；window `training-plan-applied` 已移除 | 领域失效协议 + automation 配置冲突协调 |
| UI | FPR-033 后由 `components/TrainingWorkspace` 与面板持有：选择器管 filters/search/render limit=72/图片，计划面板管 planMode，队列面板管行内焦点与 UndoToast（8s，hover/focus/pending 暂停，cleanup 清 timer），工作区管 selectorOpen、操作错误、撤销快照与 pending/busy 投影 | 最近面板；撤销意图归队列用例、toast 呈现归组件（见[养成领域面板](training-panel.md)） |

无业务 localStorage；queue 已由 FPR-021 迁入 `training/queue` Query 与串行领域命令，页面只读取快照并订阅 pending；设置已由 FPR-022 迁入 `model/settingsCommands.ts` 的模块级所有者（不进入 Query）；计划生成/应用/同步在 FPR-023 后由 `model/planCommands.ts` 的模块级所有者持有，页面只订阅状态并调用动作。候选与计数由 Query 持有：key 含筛选参数、signal 取消、列表失败清空/计数静默保旧。FPR-033 起页面只组合 `TrainingWorkspace`，面板 JSX 与 DOM 未改，状态归属见[养成领域面板](training-panel.md)。命令的串行链与 pending 状态是模块级所有者，Activity 隐藏/页面 remount 不重建；写后刷新失败时缓存保存带 `uncertain` 的本地 fallback，重新加载后清除。外部 depot/operbox/material/resource 更新经 resource-invalidation 端口到达，按作用域失效候选/计数或重读队列；本页忽略自己的队列发布。

### Settings — `pages/settings/ConfigManager.tsx`

| 职责 | 当前读写、入口与副作用 | 唯一目标所有者 |
| --- | --- | --- |
| 配置读取/草稿/保存 | GET `/agent/config/maa/default` 由 `settings/maa-config` Query 读取（signal、载荷校验）；`ConnectionConfigOwner` 持有草稿/revision/dirty，POST maa/default wire `{connection: snapshot}`；读取令牌使初始加载与 refresh 不覆盖编辑或未保存草稿，旧保存不确认新草稿；重置只改草稿 | settings connection Query + 草稿所有者（FPR-024） |
| 自动更新 | `model/autoUpdateConfig.ts` 的模块级 `AutoUpdateConfigOwner`：读取服务端 `auto-update` 并在失败时回退 `autoUpdateConfig` 本地草稿；touched/revision 防迟到读取与旧保存覆盖新编辑；保存 = user config + `/agent/actions/configure-auto-update`，两步成功才清 dirty；不自动重试、无 AbortSignal | settings 自动更新完整提交所有者（FPR-026） |
| 设备与连接 | GET `/agent/actions/discover-devices?adbPath=…` 与 POST `/agent/actions/test-connection` 由 `model/deviceConnection.ts` 的模块级 `DeviceConnectionOwner` 持有：两条链独立 loading/error/取消，signal 到 fetch；Activity 隐藏/页面卸载由 `SettingsWorkspace` 的 `useDeviceConnectionActivityCleanup` abort，section 切换不取消；选择设备以最新草稿 revision 回填 `adb_path`/`address` 后测试，响应不写草稿；POST `/agent/actions/open-config-directory` 由 `useSettingsConfigDirectory().open()` 执行 | 设备发现/连接测试所有者（FPR-025）；取消边界归工作区（FPR-034） |
| 版本/更新 | 版本读取由 `settings/version` Query 持有（signal、归一化）；POST `/agent/actions/update-core`（普通更新不传 version，切渠道传 stable/beta）、`/agent/actions/update-cli`、`/agent/actions/hot-update-resources` 由 `model/updateCommands.ts` 的 `SettingsUpdateOwner` 持有，四条命令共用一条在途槽位；成功确认后失效同一版本 Query，core/渠道/资源更新额外发布 `catalog`/`materials`/`training-plan`/`dashboard-snapshot` 并推进物品图标 epoch | 版本归资源域（FPR-025）；更新命令所有者与显式资源失效（FPR-026） |
| 配置目录 | GET `/agent/config-directory` 由 `settings/config-directory` Query 持有（接受 `{path}` 与旧字符串）；失败重试走同一 key，后台刷新失败保留最近成功路径；两个“打开目录”入口调用同一命令 | 配置目录 Query（FPR-025） |
| 存储与 UI | `laPlumaConfigSection` 读写与 window `la-pluma-config-section` 订阅由 `model/configSection.ts` + `useConfigSection` 拥有并在 Effect cleanup 注销；`autoUpdateConfig` 由自动更新所有者写入（成功加载/每次编辑/保存成功），服务端加载失败时读作 fallback；section 来自 section owner，设备/更新/自动更新反馈来自各自 owner | section 归设置 section owner（FPR-024）；设备/版本/目录归 FPR-025；更新与自动更新归 FPR-026；页面/工作区/面板组合与订阅隔离见 FPR-034 |

无页面 timer。`autoUpdateConfig` 本地已写不代表调度已应用。core/资源更新成功后按作用域失效目录、材料、计划前提与总览，并推进物品图标 epoch；CLI 只失效版本。connection 的初始读取失败保留页内与全局提示；已有数据后的后台 refresh 失败不打断编辑。FPR-034 起页面只组合 `SettingsWorkspace`；连接、设备、目录与更新面板各自订阅所属所有者/Query，设备/更新状态不重渲染连接表单。设备发现/连接测试在 Activity 隐藏时取消本地等待，已完成结果保留；section 切换不取消在途命令，设备面板从 owner 恢复显示。版本与配置目录 Query 随观察者注销/恢复；更新命令与自动更新保存不因 Activity 隐藏中断，反馈与草稿由模块级 owner 保留。详见[设置领域面板](settings-panel.md)。

### Logs — `pages/logs/LogViewer.tsx` + `components/LogsWorkspace.tsx`

| 职责 | 当前读写、入口与副作用 | 唯一目标所有者 |
| --- | --- | --- |
| 实时会话 | GET `/agent/logs/recent?lines=200`，每 1250ms HTTP 轮询；`RealtimeLogStream` 单在途、请求身份与 AbortSignal 防慢请求重叠和旧响应覆盖；每次替换最近 200 行，不是追加流 | logs 实时流所有者（FPR-027） |
| 历史查询 | GET `/agent/logs/files`；GET `/agent/logs/files/{encodedPath}?lines=1000`；列表与读取各自持有请求序号和 AbortSignal，切换选择、返回实时、Activity 隐藏/卸载都会取消旧请求，迟到响应不写新选择；协议无 cursor，选择以文件路径标识 | logs 历史会话 `HistoryLogSession`（FPR-028），见[历史日志与清理协调](logs-history-and-cleanup.md) |
| 清空/清理 | POST `/agent/logs/recent/clear` 前手动暂停并 abort，成功后清流缓冲，此前未手动暂停时恢复并立即重读，手动暂停则保持暂停；POST `/agent/logs/cleanup` `{maxSizeMB:10}` 后重读列表，若选中文件被删除则退出历史模式；命令不触碰彼此状态，页面卸载时只取消本地等待 | `model/logCommands.ts` 的清空/清理命令（FPR-028）；暂停策略接线（FPR-035） |
| 模型/展示 | `model/logModel.ts` 的 parseHistoryLine/parseRealtimeLog/summarize/过滤/折叠与 `buildLogView`；`components/LogsWorkspace.tsx` 持有 summary/raw、level/search/collapse、autoScroll、通知与确认动作；工具栏/列表/历史选择器为受控面板，`scrollTop` Effect 归 `LogConsole`；导出使用过滤后行，`model/logExport.ts` 固定文本与文件名，Blob/objectURL/anchor 由工作区执行 | 纯日志模型（FPR-027）；日志工作区与面板（FPR-035）；会话状态归实时流与历史会话 |

无业务存储，无 WebSocket/EventSource。实时流实例随页面真正挂载创建，Activity 隐藏时停止计时器并 abort 在途读取、保留缓冲，显示时立即重读；`document.hidden` 时计时器保留但守卫不发请求并 abort 在途，可见时立即重读；手动暂停不被可见性或 Activity 变化清除，恢复时立即重读，工具栏暂停/继续按钮已接线（FPR-035）。历史读取由 `HistoryLogSession` 持有：Activity 隐藏会取消列表与读取，进行中的读取转为 `cancelled` 而不是留下 loading，显示时重读列表并重试被取消的当前文件；明确失败的读取不自动重试。返回实时经页面级 `enabled` 立即重读，若此前手动暂停会先恢复；历史模式恢复不会重新启动实时轮询。暂停与清空/重试/历史返回的组合策略、工作区/工具栏/列表/历史选择器边界见[日志领域面板](logs-panel.md)；完整生命周期约定见[实时日志流生命周期](logs-realtime-stream.md)与[历史日志与清理协调](logs-history-and-cleanup.md)。

## 共同副作用与状态生命期

`FloatingStatusIndicator` 经 runtime-status 订阅全局 `runStatus`/message 与 online/offline；`operator-quotes` 发 GET `/operator-quotes/random`，模块级去重/缓存。statusStore 的消息消失计时器：success 1.5s、warning/default 3s、info 10s，error 不自动消失；设备忙（有活动 run 或未纳管占用）时暂停计时，离开忙态后重新开始。显示优先级为连接健康 > 临时消息 > 运行投影 > 干员台词。`statusStore.runStatus` 只由应用级 `useRunStatusProjection` 写入；页面与监测器都不再写运行字段（FPR-011）。

应用级 `runtime-status/hooks/useBackendStatusMonitor` 独立 GET `/agent/tasks/status`：空闲每 30s、设备忙每 2s 串行 timeout；监听 online/offline/focus 与 `runStatus` 忙态变化。探针只写 `backendStatus`/`backendMessage`；`tasks/status.isRunning` 是旧进程投影，不再用于运行状态。连接监测归 runtime-status，运行身份的唯一所有者是应用级执行控制器。

调用 `useFluidTabIndicator` 的页面使用 ResizeObserver、window resize 与测量，cleanup 撤销。Automation 的 `NotificationSettings` 当前直接使用 fetchWithAuth 调 GET/POST `/agent/notifications/config` 与 POST `/agent/actions/test-notification-channel`；模块 cache/pending 去重，草稿无 localStorage；revision 防载入盖编辑，cleanup abort 保存/测试并在恢复清 loading。目标由 notification 服务管理 API/cache，控制器管理草稿/保存/测试；独立于流程配置。Automation/Combat/Roguelike 及 Dashboard 使用 device-mirror 预览（见该域公开面和 `useDashboardPreview`），每实例会话/全局偏好、截图与 WebRTC 信令由 device-mirror 管理，按实际 tab/文档可见性暂停，不能归入运行停止语义。

预览的完整边界（均唯一归 device-mirror，页面仅消费公开面）：

- `ScreenMonitor` 挂载/恢复 GET `/agent/webrtc/status`；非 live 且 agentRunning、文档可见时 4s/18s 延后复查。POST `/agent/webrtc/install`、`/agent/webrtc/start-server`、`/agent/webrtc/stop-server`、`/agent/webrtc/start-agent`、`/agent/webrtc/stop-agent` 及组合 `/agent/webrtc/start` 控制基础设施；关闭前置 mode=off，revision/cleanup 防迟到结果。
- `usePreviewSession` 在 live + document visible + automation available 才启动，45s deadline；清理 abort、disconnect、撤 timer。`usePreviewSnapshot` 在 snapshot + 可见 + 可用时 POST `/agent/screen/screenshot`，每次完成后 10s 再读，单次 20s deadline，隐藏清画面并取消。
- `preview-storage` v1 读写 mode/autoStart/quality/fps/maxSize/bitrate；刷新仅 autoStart=true 恢复 mode，否则 off。`scrcpy_webrtc_auth_token` 在每次登录前删除、成功写入、失败删除，不复用旧值（文档与证据不记录 token 值）。
- `useScrcpyWebRTC` POST 同源 gateway `/webrtc-signaling/api/login`（外部信令分支使用 `<httpBase>/api/login`），创建 WebSocket/RTCPeerConnection/DataChannel，处理 offer/answer/ICE/视频/触控；重试 300/800ms，单次 4s、信令 12s、媒体 20s、ICE gathering 2s deadline，每秒 getStats；cleanup 拆 transport/timers/listeners。
- `ScrcpyDeviceView` 的触控 pointer capture/rAF、沉浸 portal/history/popstate/keydown/focus trap/body overflow/inert/aria-hidden/video stream 都由预览组件清理和恢复；UI mode/controls/settingsDirty 保留于 Activity。布局仍有页面自持 639/640、767/768、899/900、1024、1200、1280、1360 等边界，纯结构迁移不静默合并断点。

| 页面 | Activity hide / show | document hidden | 真正 remount / 浏览器刷新 |
| --- | --- | --- | --- |
| Automation | 保留草稿/选择/撤销/结果/摘要展开；清排序 document 监听、活动 Query 观察者与连接测试在途；show 清 loading、查状态，已 hydrated 不重载配置，活动按新鲜度重取 | 业务查询继续；预览暂停 | 重读本地/服务端与旧断点；旧续跑当前可能重提，未来改观察恢复 |
| Combat | 保留草稿/UI；Query 观察者注销并取消在途搜索/预览读取，预览会话 stop 清 loading、保留已显示预览；abort status/stop 等待；show 查运行、不自动重放搜索/预览、不重载配置 | 业务查询继续；预览暂停 | 配置/后端 running 恢复；搜索词/识别方式/选中索引重置；Query 新鲜缓存可复用；manual 当前集/结果不恢复 |
| Roguelike | 保留草稿/模式；清 status/stop 等待；show 查运行、跳过已 hydrated 配置 | 业务查询继续；预览暂停 | 配置/后端恢复，activeMode 回默认 |
| Dashboard | 停 5s/5min timers；在途业务 promise 仍可落 store；show 按时戳刷新并立即采设备 | 业务/设备 timer 继续，预览暂停 | store/模块在普通 remount 存活；刷新读完整 local cache |
| Statistics | 保留筛选/UI；失效读取；show 重读四类资源 | 无专门处理 | 所有局部状态重置 |
| Training | 保留选择器筛选/搜索/分批游标/头像缓存、计划范围、设置/计划、操作错误与撤销快照；队列命令、设置与计划所有者均为模块级，候选/计数/队列 Query 观察者随 Effect 注销；show 按新鲜度重取 queue 与候选/计数；撤销计时重新计 8s | 无专门处理 | 队列命令与计划写请求继续完成并写入应用级缓存/所有者；设置与计划状态不随 remount 重建；面板局部状态回到默认；未完成 closure 不会自动取消 |
| Settings | 重建 section 监听；连接/版本/目录 Query 观察者注销；工作区的 `useDeviceConnectionActivityCleanup` abort 在途设备发现/连接测试并保留已完成结果；自动更新初始化标记阻止重复加载，更新命令与自动更新保存在隐藏期间继续完成 | 无专门处理 | section/autoUpdate fallback 可恢复；设备结果保留（未完成已取消），版本/目录按新鲜度重取；更新命令与自动更新反馈/草稿由模块级 owner 保留；section 切换不取消设备命令 |
| Logs | 停实时计时器并 abort 在途读取；历史会话取消列表/读取并保留选择，恢复时重读列表、重试被取消的当前文件；工作区过滤/折叠/自动滚动/通知保留 | 取消实时在途读取，计时器保留但守卫不发请求；历史读取继续；可见立即重读实时（手动暂停保持） | 缓冲/选择/过滤/自动滚动全部重置，手动暂停状态随实例重置 |

## 性能对照入口与待验收边界

四类交互的固定数据、步骤、采样、浏览器指标和网络请求见[性能采样说明](evidence/frontend-baseline/performance.md)。它们测量浏览器工作与 DOM 更新；普通生产包没有 React profiling，不能把 DOM mutation 当作 React commit 次数。后续必须在同一构建方式/数据量/设备采样，真实大队列与 React Profiler 的补测条件在说明中登记。

尚待实现的边界包括：所有旧执行入口纳入 Run、manual lease 释放/重获。跨 remount 配置写入次序、automation schedule 半失败、训练设置改变后的计划有效期与计划应用跨页联动已由 FPR-015/022/023 关闭，资源更新后的目录/材料/计划/总览失效已由 FPR-026 关闭；历史日志在 Activity 隐藏后的 loading 残留与恢复重试已由 FPR-028 关闭（见[历史日志与清理协调](logs-history-and-cleanup.md)）。应用计划遇到本设备未确认的 automation 草稿（含未挂载页面留下的持久化标记）会拒绝应用，但跨标签页/跨客户端同时写入仍为最后写入生效。计划已生成/计划过期仍未纳入 72 张默认态截图，FPR-023 未改变默认态 DOM/CSS，也未更新视觉基线。后续契约与表征工作需要给出对应回归清单；不以当前截图通过推断这些条件已经满足。配置提交差异、迟到加载、跨页失效与 Dashboard 快照的实际表征见[配置同步与资源一致性契约](config-sync-and-invalidation.md)。

实际拖拽采样发现：指针移动引起重排后发生 lostpointercapture，旧处理器取消排序并还原原序，没有配置写入。FPR-039 已把 `pointermove`/`pointerup`/`pointercancel` 改挂 `document`，`lostpointercapture` 不再取消排序，并由 `AutomationTasks.layout.test.tsx` 的成功拖拽用例固定；默认态视觉未变化。性能文件中的取消样本仍只能作为前测；成功排序、补充键盘排序与双侧 React profiling 已由[最终采样](evidence/frontend-final/performance.md)重测，并明确区分操作语义和时钟协议。
