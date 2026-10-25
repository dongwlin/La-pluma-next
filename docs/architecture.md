# 架构与技术栈

> [← 返回 README](../README.md)

## 整体架构

La Pluma Next 是一个面向《明日方舟》自动化的本地 Web 控制台。前端负责配置、编排和可视化；后端负责调用 `maa` CLI、ADB、ScrcpyOverWebRTC 和本地 JSON 配置。

当前后端入口主要挂载两类 API：

- `/api/agent` - 主控制接口，覆盖 MAA 命令、任务状态、日志、截图、WebRTC、养成、调度、通知和数据接口。
- `/api/operator-quotes` - 干员语音/台词相关接口。

历史拆分路由已清理；新增功能应优先接入 `/api/agent`。设备执行的 Run 身份、状态来源以及停止、断线、刷新和外部占用边界见[执行身份与生命周期契约](execution-lifecycle.md)；前端如何保存 `runId`、传幂等键、观察快照以及区分停止与本地中止见[前端执行客户端与控制器](execution-client.md)。

### 前端 UI 与响应式壳层

前端使用 React 19、Tailwind CSS v4（`@tailwindcss/vite`；`@theme` 圆角映射 + 定向 `@utility` 间距映射，无 JS 配置）和 Framer Motion。`Layout` 与 `shared/ui` 通用组件使用原生语义元素实现页面 chrome、导航栏、移动 tabbar 和模态交互；`styles/` 下的语义 token 与 `ios-theme.css` 统一 iOS 26 材质、La Pluma Next 品牌色和信息密度。

React Router 7（library 模式的 `BrowserRouter`）是当前 tab 与 URL 的唯一事实来源：`app/router/` 维护 tab 元数据、路由表与 URL 归一（`/`、`/app`、`/app/`、未知 tab 归一到默认页），`Layout` 只负责导航外观与按 tab 的滚动恢复。访问过的页面由 `Activity` 保活，切换 tab 只切换可见性、不卸载页面；因此不使用 `<Routes>`/`useRoutes`，避免路由导航卸载上一页。安装后的 PWA（standalone）同样走 URL 历史导航，不再用 `history.state` 单独记录当前 tab：刷新与深链会保留当前页面，升级前写入 `history.state` 的旧 tab 记录不再读取。

桌面与移动导航、主题、安全区、响应式断点等界面规则以根目录 [设计规范](../DESIGN.md) 为唯一来源；组件 API 见 [通用组件库](component-library.md)。新增页面应复用现有 `Layout`、`shared/ui` 通用组件和语义 token，不要重复实现导航壳层或页面级安全区计算。

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

前端按 `app → features → shared` 三层垂直切分（依赖只能单向向下）：

- `app/`：应用组装——根组件、路由表与 URL 归一、布局壳与 Provider，不含业务逻辑。
- `features/*`：功能域，页面、域内组件、hooks、store、api、类型与常量全部自持；页面级 CSS 同样由各域自持，放在 `features/<domain>/styles/` 并由该域 `index.ts` 导入（统一收进 `@layer page`）。对外只有 `index.ts` 一个公开面，其他域与 `app/` 一律 `@/features/<domain>` 根 import。
- `shared/`：与业务无关的横向下层（通用 UI、传输层底座、Query 缓存基础设施、路由词汇与全局 store、通用 hooks、跨域纯函数）；不感知 `features` 与 `app`。

业务端点按语义归各 `features/<domain>/api/`；跨域共用的端点组独立为非页面微域（`task-execution`、`user-config`、`game-data`），不在 `shared/api` 留任何业务方法。`shared/api` 只保留协议/传输层底座。

已知接受项（FPR-018 后）：仓库、持有干员与干员目录由非页面微域 `features/game-data` 统一持有，`training` 与 `statistics` 不再为共享资源互相 import；`statistics` 仍单向依赖 `training` 的队列读取与材料刷新命令，`Dashboard` 仍直接读取 `training`/`statistics` 的队列与掉落/开放关卡，待资源读写任务迁移。跨域写入后的刷新经 `features/resource-invalidation` 端口协调，不在页面之间新增轮询。详见[共享资源归属与失效端口](resource-ownership.md)。

```
La-pluma-next/
├── DESIGN.md                  # UI 设计规范（开发者与 Agent 的唯一来源）
├── client/                    # 前端 (React + TypeScript + Vite + Tailwind CSS v4 + Framer Motion)
│   ├── src/
│   │   ├── main.tsx           # 入口：import './styles' 并挂载 @/app/App
│   │   ├── styles/            # 启动族全局样式资产（不参与三层分层）
│   │   │   ├── index.ts       # side-effect 入口
│   │   │   ├── index.css      # 层序 + Tailwind 入口、语义 token 单源、@theme/@utility、通用组件类、跨域 keyframes
│   │   │   └── ios-theme.css  # iOS 26 chrome/材质 token 与样式、跨域 page-kind 材质（不再重定义语义 token）
│   │   ├── app/               # 应用组装层
│   │   │   ├── App.tsx        # 根组件：BrowserRouter + Provider + Layout + 页面出口
│   │   │   ├── router/        # tab 元数据、路由表、URL 归一与保活页面出口（react-router）
│   │   │   ├── layout/        # Layout（导航壳与按 tab 滚动恢复）、ThemeToggle、PWAInstallPrompt
│   │   │   └── providers/     # QueryClient Provider、MotionConfig、主题 dark-class 副作用
│   │   ├── features/          # 功能域（对外只有 index.ts）
│   │   │   ├── dashboard/     # 控制台总览
│   │   │   ├── automation/    # 日常任务流程
│   │   │   ├── combat/        # 作业、SSS、悖论模拟
│   │   │   ├── roguelike/     # 肉鸽模式
│   │   │   ├── training/      # 养成队列、设置、计划与候选/材料端点
│   │   │   ├── statistics/    # 掉落、开放关卡与统计展示
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
│   │   ├── agent.js           # 主 Agent API
│   │   └── operatorQuotes.js  # 干员台词接口
│   ├── services/              # 业务逻辑
│   │   ├── maaService.js      # MAA CLI、ADB、截图、实时日志
│   │   ├── schedulerService.js # 定时任务调度
│   │   ├── notificationService.js # 通知服务
│   │   ├── operatorTrainingService.js # 养成计划和材料计算
│   │   ├── webrtcService.js   # ScrcpyOverWebRTC 管理
│   │   └── configStorageService.js # 配置存储
│   ├── data/                  # 用户配置数据
│   │   └── user-configs/      # 任务配置 JSON 文件
│   └── server.js              # 服务器入口
├── pnpm-workspace.yaml        # pnpm 工作区配置
├── pnpm-lock.yaml             # 统一依赖锁文件
├── package.json               # 根目录脚本（pnpm workspace 入口）
└── README.md                  # 项目入口与快速开始
```

`shared/types/` 已在 Phase 2a 解散：域类型归各 `features/<domain>/types/`，该目录已删除。

开发流程与常用检查见 [开发文档](development.md)。
