# 架构与技术栈

> [← 返回 README](../README.md)

## 整体架构

La Pluma Next 是一个面向《明日方舟》自动化的本地 Web 控制台。前端负责配置、编排和可视化；后端负责调用 `maa` CLI、ADB、ScrcpyOverWebRTC 和本地 JSON 配置。

当前后端入口主要挂载两类 API：

- `/api/agent` - 主控制接口，覆盖 MAA 命令、任务状态、日志、截图、WebRTC、养成、调度、通知和数据接口。
- `/api/operator-quotes` - 干员语音/台词相关接口。

历史拆分路由已清理；新增功能应优先接入 `/api/agent`。

### 前端 UI 与响应式壳层

前端使用 React 19、Tailwind CSS 和 Framer Motion。`Layout` 与 common 组件使用原生语义元素实现页面 chrome、导航栏、移动 tabbar 和模态交互；语义 token 与 `ios-theme.css` 统一 iOS 26 材质、La Pluma Next 品牌色和信息密度。

桌面与移动导航、主题、安全区、响应式断点等界面规则以根目录 [设计规范](../DESIGN.md) 为唯一来源；组件 API 见 [通用组件库](component-library.md)。新增页面应复用现有 `Layout`、common 组件和语义 token，不要重复实现导航壳层或页面级安全区计算。

## 技术栈

- **前端框架**: React 19 + TypeScript + Vite
- **UI 框架**: Tailwind CSS + Framer Motion + 项目语义组件与 `ios-theme.css`
- **图标**: Lucide React
- **状态管理**: Zustand
- **后端**: Node.js + Express
- **实时通信**: Socket.io
- **MAA 集成**: 通过子进程调用 `maa` CLI 命令
- **模拟器连接**: ADB + ScrcpyOverWebRTC
- **数据来源**: MAA 识别结果和本地游戏数据 JSON
- **通知服务**: Telegram Bot API 和任务完成通知

## 项目结构

```
La-pluma-next/
├── DESIGN.md                  # UI 设计规范（开发者与 Agent 的唯一来源）
├── client/                    # 前端 (React + TypeScript + Vite + Tailwind CSS + Framer Motion)
│   ├── src/
│   │   ├── components/        # UI 组件
│   │   │   ├── Dashboard.tsx          # 控制台总览
│   │   │   ├── AutomationTasks.tsx    # 日常任务流程
│   │   │   ├── CombatTasks.tsx        # 作业、SSS、悖论模拟
│   │   │   ├── RoguelikeTasks.tsx     # 肉鸽模式
│   │   │   ├── OperatorTraining.tsx   # 干员养成计划
│   │   │   ├── DataStatistics.tsx     # 仓库、干员和掉落数据
│   │   │   ├── LogViewer.tsx          # 日志查看
│   │   │   ├── ConfigManager.tsx      # 配置管理
│   │   │   ├── ScreenMonitor.tsx      # 截图与设备预览
│   │   │   ├── ScrcpyDeviceView.tsx   # WebRTC 实时预览
│   │   │   └── ...
│   │   ├── services/          # API 调用
│   │   │   └── api.ts         # /api/agent API 封装
│   │   ├── stores/            # Zustand 状态管理
│   │   ├── hooks/             # 预览、API 请求等 Hook
│   │   └── utils/             # 工具函数
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

开发流程与常用检查见 [开发文档](development.md)。
