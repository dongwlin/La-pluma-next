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

前端按 `app → pages → features → shared` 四层垂直切分（依赖只能单向向下）：

当前状态与资源所有者的集中说明见[前端架构与所有权](frontend-architecture.md)，兼容消费者与支持窗口见[前端兼容入口与移除规则](frontend-migration.md)。

- `app/`：应用组装——根组件、路由表与 URL 归一、布局壳与 Provider，不含业务逻辑。
- `pages/<domain>/`：页面层——按域组合页头、领域工作区与布局，只经 `@/features/<domain>` 根入口和 `shared/` 取用；不持有配置草稿、传输或运行状态。页面测试与被测页同目录，可深路径构造领域内部状态，不进入产物。
- `features/*`：功能域，域内组件、hooks、store、api、类型与常量全部自持；页面级 CSS 同样由各域自持，放在 `features/<domain>/styles/` 并由该域 `index.ts` 导入（统一收进 `@layer page`）。对外只有 `index.ts` 一个公开面，其他域、`pages/` 与 `app/` 一律 `@/features/<domain>` 根 import。
- `shared/`：与业务无关的横向下层（通用 UI、传输层底座、Query 缓存基础设施、路由词汇与全局 store、通用 hooks、跨域纯函数）；不感知 `features`、`pages` 与 `app`。

业务端点按语义归各 `features/<domain>/api/`；跨域共用的端点组独立为非页面微域（`task-execution`、`user-config`、`game-data`），不在 `shared/api` 留任何业务方法。`shared/api` 只保留协议/传输层底座。

现行共享资源由 `features/game-data` 持有，`training` 与 `statistics` 通过单向依赖与失效端口协作，业务读取由各领域 Query 管理；总览使用原子快照，页面的执行、配置和资源请求分别交由控制器、协调器与领域所有者处理。各页面工作区的面板职责、局部状态、Activity 生命期以及兼容规则见[前端架构与所有权](frontend-architecture.md)和对应领域专题文档。

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

## 状态与资源所有权

当前页面、领域容器与全局状态的职责按以下唯一所有者划分。页面只负责布局、页头与领域组合；`components/`、`hooks/` 等领域容器可以调用所属领域的 hook、Query 与命令所有者。

| 状态 / 资源 | 唯一所有者 | 页面与面板职责 | 契约 |
| --- | --- | --- | --- |
| 执行身份、流程进度、终态 | 服务端 Run；`features/task-execution` 的 `ExecutionController` 负责提交、观察与目标停止 | 订阅执行快照并发送操作，不复制运行状态机；页面隐藏/卸载不停止观察 | [执行身份与生命周期](execution-lifecycle.md)、[前端执行客户端](execution-client.md) |
| 连接健康与全局运行展示 | `features/runtime-status` 的后端探针；运行字段只由 `useRunStatusProjection` 从控制器投影 | 呈现连接/运行状态；断线不能写成任务完成，页面不写运行字段 | [执行客户端](execution-client.md) |
| 配置草稿、pending 与完整提交 | `features/user-config` 按 key 的协调器 + combat/roguelike/automation 域适配器；automation 的 task flow 与 schedule 是同一完整提交单元 | 编辑/订阅草稿与 `syncState`，调用 `retry()`；页面不重建提交队列、不把 `saveUserConfig` 成功当成全部提交成功 | [配置持久化协调器](config-persistence.md) |
| 设置与养成配置写入 | 设置连接：`settings/maa-config` Query + `model/connectionConfig.ts` 草稿所有者；自动更新：`model/autoUpdateConfig.ts`；养成设置：`training/model/settingsCommands.ts`；养成计划：`training/model/planCommands.ts` 与 `planValidity.ts` | 编辑、保存、重置表单并订阅 pending/版本；迟到读取与旧保存不覆盖新草稿；页面不直接写存储或维护第二份可写设置 | [设置配置编辑](settings-config-editing.md)、[自动更新](settings-updates-and-auto-update.md)、[养成设置与计划有效期](training-settings-and-plan-validity.md) |
| 服务端只读资源 | 资源所属领域的 Query：`game-data`（仓库/持有干员/目录）、`statistics`（掉落/开放关卡）、`training`（队列/候选/计数）、`automation`（活动/流程进度）、`settings`（连接/版本/目录）、`device-mirror`（设备采样） | 经领域 query 读取并渲染；筛选、展开、选中项等 UI 状态留在最近面板；不在 Zustand 再存一份可写资源 | [Query 缓存与键规范](query-cache.md)、[共享资源归属](resource-ownership.md) |
| 总览完整快照与设备历史 | `features/dashboard/model` 的刷新协调器与 `dashboardStore` 受控投影；设备样本归 `device-mirror` | 五路业务数据全部有效才原子提交；采样失败保旧值；页面不单独发起业务请求 | [总览完整快照与设备采样](dashboard-snapshot.md) |
| 日志实时/历史会话与设备预览 | `features/logs` 的 `realtimeLogStream`/`historyLogSession`；`features/device-mirror` 的预览会话与 WebRTC transport | 按 Activity/文档可见性暂停恢复；页面不建立第二份轮询、日志缓冲或 WebRTC 连接 | [实时日志流](logs-realtime-stream.md)、[历史日志与清理](logs-history-and-cleanup.md) |
| 跨域资源失效 | `features/resource-invalidation` 端口；写入成功后由领域命令发布 | 订阅失效范围并按需刷新；页面之间不新增轮询 | [共享资源归属与失效端口](resource-ownership.md) |
| 跨页客户端状态 | Zustand：主题、连接健康、运行投影、预览偏好等非资源状态 | 不把 Query 数据、配置草稿或运行记录复制进全局 store | [Query 缓存](query-cache.md) |
| 页面/面板局部状态 | 最近的面板或工作区；跨面板共享时上移 | Activity 隐藏保留 React 状态并清理 Effects；真正卸载/刷新才销毁 | [前端架构与所有权](frontend-architecture.md) |

页面不得直接持有传输、存储或业务轮询原语；服务端读取走领域 Query，配置写入走协调器，运行观察走控制器，日志/设备等流归对应会话所有者。领域容器可以按需调用 `fetchWithAuth`、计时器与领域 hook，这不是页面越权。

## 依赖与职责护栏

`app → pages → features → shared` 的单向依赖、feature 公开面、`task-execution` 不反向依赖页面域、页面裸副作用，以及 hooks/model/components/pages 的规模观察由 `client/scripts/check-guardrails.ts` 自动检查，并作为客户端 `verify` 的第一步运行：

```bash
pnpm --filter la-pluma-next-client guardrails
```

规模预算冻结在 `client/size-budget.json`，阈值依据迁移后的实际分类分布而不是统一的 150 行，并检查同域页面缩减是否被搬进 hooks/model/components（缩减 ≥40 行且增长 ≥80% 判为疑似搬移）；规则、阈值表、更新方式和已知限制见[依赖与职责护栏](guardrails.md)。ESLint 继续负责编辑器内的深路径与分层即时报错，CLI 额外覆盖相对路径绕过、真实域环、页面职责与规模预算。

开发流程与常用检查见 [开发文档](development.md)。
