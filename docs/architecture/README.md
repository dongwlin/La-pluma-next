# 架构与技术栈

> [← 返回文档索引](../README.md)

## 整体架构

La Pluma Next 是一个面向《明日方舟》自动化的本地 Web 控制台。前端负责配置、编排和可视化；后端负责调用 `maa` CLI、ADB、ScrcpyOverWebRTC 和本地 JSON 配置。

当前后端入口主要挂载两类 API：

- `/api/agent` - 主控制接口，覆盖 MAA 命令、任务状态、日志、截图、WebRTC、养成、调度、通知和数据接口。
- `/api/operator-quotes` - 干员语音/台词相关接口。

历史拆分路由已清理；新增功能应优先接入 `/api/agent`。设备执行的 Run 身份、状态来源以及停止、断线、刷新和外部占用边界见[执行身份与生命周期契约](execution-lifecycle.md)；前端如何保存 `runId`、传幂等键、观察快照以及区分停止与本地中止见[前端执行客户端与控制器](execution-client.md)。

### 前端 UI 与响应式壳层

前端使用 React 19、Tailwind CSS v4（`@tailwindcss/vite`；`@theme` 圆角映射 + 定向 `@utility` 间距映射，无 JS 配置）和 Framer Motion。`Layout` 与 `shared/ui` 通用组件使用原生语义元素实现页面 chrome、导航栏、移动 tabbar 和模态交互；`styles/` 下的语义 token 与 `ios-theme.css` 统一 iOS 26 材质、La Pluma Next 品牌色和信息密度。

URL 导航、路径归一、PWA 历史记录与 Activity 保活的约定统一见[前端架构与所有权](../frontend/README.md)。

桌面与移动导航、主题、安全区、响应式断点等界面规则以根目录 [设计规范](../../DESIGN.md) 为唯一来源；组件 API 见 [通用组件库](../frontend/components.md)。新增页面应复用现有 `Layout`、`shared/ui` 通用组件和语义 token，不要重复实现导航壳层或页面级安全区计算。

## 技术栈

- **前端框架**: React 19 + TypeScript + Vite
- **UI 框架**: Tailwind CSS v4（`@tailwindcss/vite`，CSS-first 配置）+ Framer Motion + 项目语义组件与 `src/styles/ios-theme.css`
- **图标**: Lucide React
- **路由**: React Router 7（`BrowserRouter`，URL 即 tab 状态）
- **状态管理**: Zustand（跨页客户端状态）
- **服务端缓存**: TanStack Query 5（应用级 QueryClient，策略与键规范见 [Query 缓存与键规范](query-cache.md)）
- **后端**: Node.js + Express
- **实时通信**: HTTP 轮询（执行/日志状态）+ WebRTC 同源信令网关（浏览器实时预览）
- **MAA 集成**: 通过子进程调用 `maa` CLI 命令
- **模拟器连接**: ADB + ScrcpyOverWebRTC
- **数据来源**: MAA 识别结果和本地游戏数据 JSON
- **通知服务**: Telegram Bot API 和任务完成通知

## 项目结构

前端生产源码按 `app → pages → features → shared` 组织；依赖方向、公开面、状态所有者与生命周期统一见[前端架构与所有权](../frontend/README.md)，旧入口消费者与支持窗口见[兼容规则](../frontend/compatibility.md)。下方目录树用于定位实现，各领域行为从前端架构链接进入。

```
La-pluma-next/
├── DESIGN.md                  # UI 设计规范（开发者与 Agent 的唯一来源）
├── client/                    # 前端 (React + TypeScript + Vite + Tailwind CSS v4 + Framer Motion)
│   ├── src/
│   │   ├── main.tsx           # 入口：import './styles' 并挂载 @/app/App
│   │   ├── styles/            # 启动族全局样式资产（不参与四层分层）
│   │   │   ├── index.ts       # side-effect 入口
│   │   │   ├── index.css      # 层序 + Tailwind 入口、语义 token 单源、@theme/@utility、通用组件类、跨域 keyframes
│   │   │   └── ios-theme.css  # iOS 26 chrome/材质 token 与样式、跨域 page-kind 材质（不再重定义语义 token）
│   │   ├── app/               # 应用组装层
│   │   │   ├── App.tsx        # 根组件：BrowserRouter + Provider + Layout + 页面出口
│   │   │   ├── router/        # tab 元数据、路由表、URL 归一与保活页面出口（react-router）
│   │   │   ├── layout/        # Layout（导航壳与按 tab 滚动恢复）、ThemeToggle、PWAInstallPrompt
│   │   │   └── providers/     # QueryClient Provider、MotionConfig、主题 dark-class 副作用
│   │   ├── pages/             # 页面层：按域组合页头与领域工作区
│   │   ├── features/          # 功能域（对外只有 index.ts）
│   │   │   ├── dashboard/     # 控制台总览
│   │   │   ├── automation/    # 日常任务流程
│   │   │   ├── combat/        # 作业、SSS、悖论模拟
│   │   │   ├── roguelike/     # 肉鸽模式
│   │   │   ├── training/      # 养成队列、设置、计划与候选/材料端点
│   │   │   ├── statistics/    # 掉落、开放关卡、统计查询与筛选展示
│   │   │   ├── logs/          # 日志查看
│   │   │   ├── settings/      # 配置管理
│   │   │   ├── task-execution/   # 命令执行、Run 观察与执行控制器（跨域微域，非页面域）
│   │   │   ├── user-config/      # 用户任务配置读写与持久化协调器（跨域微域，非页面域）
│   │   │   ├── game-data/        # 仓库、持有干员与干员目录共享读取（跨域微域，非页面域）
│   │   │   ├── resource-invalidation/ # 跨域资源失效发布/订阅端口与 hook
│   │   │   ├── runtime-status/   # 后端连接与任务运行状态（非页面域）
│   │   │   ├── device-mirror/    # 投屏/截图预览（非页面域）
│   │   │   └── operator-quotes/  # 干员语录服务（非页面域）
│   │   └── shared/            # 横向下层
│   │       ├── ui/            # 通用组件库（Button/Card/Modal/...）
│   │       ├── navigation/    # tab 词汇表、router-relative 路径助手、useActiveAppTab
│   │       ├── stores/        # shared 自管的全局 store（uiStore：主题）
│   │       ├── api/           # 传输层底座：API_BASE_URL、fetchWithAuth、
│   │       │                  # parseJsonResponse、getErrorMessage 与响应类型
│   │       ├── query/         # 应用级 QueryClient、默认策略与 key 工厂
│   │       ├── hooks/         # useFluidTabIndicator、useOnlineStatus、usePageVisible
│   │       └── utils/         # executionSummary、taskStatus
│   └── public/                # 静态资源（Logo、图标）
├── docs/                      # 项目文档（架构、Agent API、功能、配置、部署、开发、组件库、维护）
├── server/                    # 后端 (Node.js + Express)
│   ├── routes/                # API 路由
│   │   ├── agent.ts           # 主 Agent API（聚合领域 router）
│   │   ├── agentExecution.ts # tracked 执行、流程/作业集与目标停止
│   │   ├── executionDto.ts   # 执行请求按端点收窄与 Run 响应载荷
│   │   ├── agentStatusRoutes.ts # 状态汇总与 Run 查询（ADB 探测有副作用）
│   │   ├── agentLogRoutes.ts  # 实时/历史日志读取、清空与清理
│   │   ├── agentDataRoutes.ts # 今日关卡、掉落与本地游戏数据读取
│   │   ├── readDto.ts         # 读取请求收窄与状态/掉落/游戏数据响应载荷
│   │   ├── agentTrainingRoutes.ts # 养成队列、设置、候选与计划生成/应用
│   │   ├── trainingDto.ts     # 养成请求按端点收窄与候选/计数响应载荷
│   │   ├── agentPreviewRoutes.ts # 截图、WebRTC、方向与设备采样预览适配
│   │   ├── previewDto.ts      # 预览设备/方向/dryRun 请求收窄与截图/状态载荷
│   │   ├── agentNotificationRoutes.ts # 通知频道配置、测试与发送适配
│   │   ├── notificationDto.ts # 通知请求收窄、保存/应用结果与响应载荷
│   │   ├── agentMaintenanceRoutes.ts # 连接/profile、资源与核心更新、定时配置及维护动作
│   │   ├── maintenanceDto.ts  # 维护请求收窄、上游响应结构与维护动作载荷
│   │   ├── deviceStatus.ts    # ADB/WebRTC/显示状态探测适配
│   │   ├── requestConnection.ts # 请求级连接覆盖解析
│   │   ├── userConfig.ts      # 用户配置 HTTP 适配（存储实例经应用组装注入）
│   │   ├── operatorQuotes.ts  # 干员台词接口
│   │   └── operatorQuotesDto.ts # 台词请求按端点收窄与业务错误文案
│   ├── services/              # 业务逻辑
│   │   ├── maaProcessService.ts # MAA CLI 子进程、实时日志与停止
│   │   ├── maaExecutionService.ts # 执行租约门禁、CLI 命令与动态任务
│   │   ├── maaConfigService.ts # MAA profile 读取与原子写入
│   │   ├── maaDeviceService.ts # ADB 探测、连接测试与截图
│   │   ├── maaLogFileService.ts # 日志文件边界、清理与检查点
│   │   ├── maaActivityService.ts # 当前活动查询与关卡代号替换
│   │   ├── maaTaskCacheService.ts # 本地任务私有 hot-update 缓存
│   │   ├── schedulerService.ts # 流程执行器组装、Run 关联与定时任务公开入口
│   │   ├── scheduleFlowPlan.ts # 流程校验、命令构建与执行计划（纯函数）
│   │   ├── scheduleFlowExecution.ts # 流程步骤编排、进度状态与停止门控
│   │   ├── scheduleFlowResult.ts # 流程结果聚合与掉落汇报解析（纯函数）
│   │   ├── scheduleExecutionPorts.ts # 设备、通知与存储适配的端口组装
│   │   ├── scheduleTriggerService.ts # cron 触发源注册、替换与自动更新作业
│   │   ├── scheduleSmartTrainingService.ts # 流程结束后的智能养成关卡回写
│   │   ├── notificationService.ts # 通知配置、格式化与渠道发送
│   │   ├── operatorTrainingService.ts # 养成领域接口：候选、队列命令、计划入口与数据抓取
│   │   ├── operatorTrainingModel.ts # 设置归一化、候选投影与材料需求（纯函数）
│   │   ├── operatorTrainingPlan.ts # 配方展开、掉落估算与刷取计划
│   │   ├── operatorTrainingStore.ts # 队列、游戏数据与 automation 配置读写与校验
│   │   ├── operatorTrainingApplication.ts # 计划应用、流程与定时同步的部分成功上报
│   │   ├── webrtcService.ts   # ScrcpyOverWebRTC 进程、viewer 与会话所有权
│   │   ├── webrtcRuntime.ts   # 平台二进制、宿主网络地址与发布包安装
│   │   ├── webrtcSignalingGateway.ts # 同源一次性票据与 WebSocket 升级代理
│   │   └── configStorageService.ts # 配置存储
│   ├── data/                  # 用户配置数据
│   │   └── user-configs/      # 任务配置 JSON 文件
│   ├── app.ts                 # Express 应用装配（中间件与路由挂载）
│   └── server.ts              # 服务器入口（HTTP/HTTPS 传输与启动）
├── pnpm-workspace.yaml        # pnpm 工作区配置
├── pnpm-lock.yaml             # 统一依赖锁文件
├── package.json               # 根目录脚本（pnpm workspace 入口）
└── README.md                  # 项目入口与快速开始
```

领域类型归各 `features/<domain>/types/`，不集中到 `shared/types/`。

## 后端组装与启动

`server/app.ts` 通过 `createLaPlumaApp(options)` 创建独立 Express 应用，接收信令登录、就绪快照和配置存储等注入端口。`/api` router 内先认证再解析 JSON，挂载业务路由后由统一 JSON 404 与错误出口收尾；生产静态文件与 SPA fallback 最后挂载，共同排除 API、探针和信令命名空间。探针与信令登录不经过业务 JSON 解析。HTTP 回归使用应用工厂和本机临时监听器，无需恢复调度、Telegram 或真实设备运行时。

`server/server.ts` 的 `createLaPlumaServer(options)` 同步校验传输配置并组装生命周期，返回尚未监听的句柄；`start()` 才恢复 Run 存储、挂载信令网关、监听 HTTP/HTTPS 并初始化后台领域，重复调用复用同一次启动。直接执行入口先安装 SIGINT/SIGTERM 处理，再调用 `start()`，初始化期间即可关闭准入、取消初始化并进入 draining。`startLaPlumaServer(options)` 保留为一步启动入口。初始化退出与资源释放共用关闭截止时间；HTTP 等待在途响应完成，超时才强制断开。启动回滚复用统一释放结果，网关关闭失败仍会排空 HTTP；具体执行收尾语义见[执行身份与生命周期契约](execution-lifecycle.md#56-运行时关闭与后台触发源)。

## 状态与资源所有权

状态所有者与页面/领域容器的职责统一维护在[前端架构与所有权](../frontend/README.md)。执行、配置、Query 和跨域失效的详细契约分别由该页链接到对应专题。

## 依赖与职责护栏

`app → pages → features → shared` 的单向依赖、feature 公开面、`task-execution` 不反向依赖页面域、页面裸副作用，以及 hooks/model/components/pages 的规模观察由 `client/scripts/check-guardrails.ts` 自动检查，并作为客户端 `verify` 的第一步运行：

```bash
pnpm --filter la-pluma-next-client guardrails
```

规模预算冻结在 `client/size-budget.json`，阈值依据迁移后的实际分类分布而不是统一的 150 行，并检查同域页面缩减是否被搬进 hooks/model/components（缩减 ≥40 行且增长 ≥80% 判为疑似搬移）；规则、阈值表、更新方式和已知限制见[依赖与职责护栏](../development/guardrails.md)。ESLint 继续负责编辑器内的深路径与分层即时报错，CLI 额外覆盖相对路径绕过、真实域环、页面职责与规模预算。

开发流程与常用检查见 [开发文档](../development/README.md)。
