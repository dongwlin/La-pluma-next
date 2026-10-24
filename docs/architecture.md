# 架构与技术栈

> [← 返回 README](../README.md)

## 整体架构

La Pluma Next 是一个面向《明日方舟》自动化的本地 Web 控制台。前端负责配置、编排和可视化；后端负责调用 `maa` CLI、ADB、ScrcpyOverWebRTC 和本地 JSON 配置。

当前后端入口主要挂载两类 API：

- `/api/agent` - 主控制接口，覆盖 MAA 命令、任务状态、日志、截图、WebRTC、养成、调度、通知和数据接口。
- `/api/operator-quotes` - 干员语音/台词相关接口。

历史拆分路由已清理；新增功能应优先接入 `/api/agent`。

### 前端 UI 与响应式壳层

前端使用 React 19、Tailwind CSS v4（`@tailwindcss/vite`；`@theme` 圆角映射 + 定向 `@utility` 间距映射，无 JS 配置）和 Framer Motion。`Layout` 与 `shared/ui` 通用组件使用原生语义元素实现页面 chrome、导航栏、移动 tabbar 和模态交互；`styles/` 下的语义 token 与 `ios-theme.css` 统一 iOS 26 材质、La Pluma Next 品牌色和信息密度。

桌面与移动导航、主题、安全区、响应式断点等界面规则以根目录 [设计规范](../DESIGN.md) 为唯一来源；组件 API 见 [通用组件库](component-library.md)。新增页面应复用现有 `Layout`、`shared/ui` 通用组件和语义 token，不要重复实现导航壳层或页面级安全区计算。

## 技术栈

- **前端框架**: React 19 + TypeScript + Vite
- **UI 框架**: Tailwind CSS v4（`@tailwindcss/vite`，CSS-first 配置）+ Framer Motion + 项目语义组件与 `src/styles/ios-theme.css`
- **图标**: Lucide React
- **状态管理**: Zustand
- **后端**: Node.js + Express
- **实时通信**: Socket.io
- **MAA 集成**: 通过子进程调用 `maa` CLI 命令
- **模拟器连接**: ADB + ScrcpyOverWebRTC
- **数据来源**: MAA 识别结果和本地游戏数据 JSON
- **通知服务**: Telegram Bot API 和任务完成通知

## 项目结构

前端按 `app → features → shared` 三层垂直切分（依赖只能单向向下）：

- `app/`：应用组装——根组件、页面注册表、布局壳与 Provider，不含业务逻辑。
- `features/*`：功能域，页面、域内组件、hooks、store、api、类型与常量全部自持；页面级 CSS 同样由各域自持，放在 `features/<domain>/styles/` 并由该域 `index.ts` 导入（统一收进 `@layer page`）。对外只有 `index.ts` 一个公开面，其他域与 `app/` 一律 `@/features/<domain>` 根 import。
- `shared/`：与业务无关的横向下层（通用 UI、传输层底座、导航/全局 store、通用 hooks、跨域纯函数）；不感知 `features` 与 `app`。

业务端点按语义归各 `features/<domain>/api/`；跨域共用的端点组独立为非页面微域（`task-execution`、`user-config`），不在 `shared/api` 留任何业务方法。`shared/api` 只保留协议/传输层底座。

已知接受项：`features/training` 与 `features/statistics` 通过各自 `index.ts` 互相消费域内 API（养成页面用统计域的干员仓库数据/图标端点，统计页面用养成域的队列/材料/名册端点），形成模块级引用环。两域不得在模块顶层读取对方的导出，跨域调用只允许发生在组件或函数运行时；新增此类跨域依赖时需在评审中确认。

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
│   │   │   ├── App.tsx        # 根组件：Provider + Layout + 页面出口
│   │   │   ├── router/        # tab 注册表与页面组件静态映射
│   │   │   ├── layout/        # Layout、ThemeToggle、PWAInstallPrompt
│   │   │   └── providers/     # MotionConfig、主题 dark-class 副作用
│   │   ├── features/          # 功能域（对外只有 index.ts）
│   │   │   ├── dashboard/     # 控制台总览
│   │   │   ├── automation/    # 日常任务流程
│   │   │   ├── combat/        # 作业、SSS、悖论模拟
│   │   │   ├── roguelike/     # 肉鸽模式
│   │   │   ├── training/      # 干员养成计划与养成端点
│   │   │   ├── statistics/    # 仓库、干员和掉落数据
│   │   │   ├── logs/          # 日志查看
│   │   │   ├── settings/      # 配置管理
│   │   │   ├── task-execution/   # 命令执行与任务状态控制（跨域微域，非页面域）
│   │   │   ├── user-config/      # 用户任务配置读写（跨域微域，非页面域）
│   │   │   ├── runtime-status/   # 后端连接与任务运行状态（非页面域）
│   │   │   ├── device-mirror/    # 投屏/截图预览（非页面域）
│   │   │   └── operator-quotes/  # 干员语录服务（非页面域）
│   │   └── shared/            # 横向下层
│   │       ├── ui/            # 通用组件库（Button/Card/Modal/...）
│   │       ├── stores/        # shared 自管的全局 store（uiStore）
│   │       ├── api/           # 传输层底座：API_BASE_URL、fetchWithAuth、
│   │       │                  # parseJsonResponse、getErrorMessage 与响应类型
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
