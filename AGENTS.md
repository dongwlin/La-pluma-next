# 仓库开发指南

## 项目与工作范围

La Pluma Next 是面向《明日方舟》自动化的本地 Web 控制台。React + TypeScript 前端负责配置、编排和可视化；Node.js + Express 后端调用 `maa` CLI、ADB 和 ScrcpyOverWebRTC，管理本地 JSON 数据。执行与日志状态通过 HTTP 轮询读取，设备预览使用同源 WebRTC 信令网关。

从本指南开始，按任务读取「延伸阅读」中的子指南和专题文档。

| 位置 | 职责 |
| --- | --- |
| `client/` | 页面、领域逻辑、共享 UI、浏览器测试和 PWA 构建 |
| `server/` | HTTP API、任务执行、调度、设备连接、通知和持久化 |
| `docs/` | 现行架构、领域契约、开发与运维说明 |
| `scripts/` | 根工作区的 Docker 视觉测试入口与容器启动检查 |
| `.github/workflows/` | 质量检查、视觉比对与 GHCR 镜像发布 |

## 环境与常用命令

使用 Node.js 24+ 和根工作区固定的 pnpm 12.6.0。依赖统一从仓库根目录安装；依赖变更同步维护根锁文件，不引入子包锁文件。

以下命令均在仓库根目录执行，完整脚本以各包的 `scripts` 为准。

| 目的 | 命令 |
| --- | --- |
| 安装依赖 | `pnpm install`（复现 CI 时加 `--frozen-lockfile`） |
| 同时启动前后端 | `pnpm dev` |
| 只启动前端 / 后端 | `pnpm dev:client` / `pnpm dev:server` |
| 构建与检查 | `pnpm build`：前端类型检查、构建与 precache 校验；后端语法检查 |
| 全仓单元测试 | `pnpm test` |
| 全仓主要质量检查 | `pnpm verify`：客户端护栏、Lint、类型检查、测试、构建，以及服务端语法检查与测试 |

`pnpm verify` 不包含样式预算、视觉比对和浏览器集成检查；涉及前端时按客户端指南补充。真实设备联调还需要 MAA CLI、MaaCore 及资源、ADB；普通单元测试与使用 fixture 的浏览器测试不代表真实设备已验证。

## 修改与交付

- 先定位已有领域、服务和状态所有者，再扩展对应实现；跨前后端的功能同步核对请求、响应和持久化契约。
- 新行为、Bug 修复及执行/异步边界的改动应新增或更新对应回归测试；格式沿用所改文件，检查使用现有脚本。
- 代码改动先运行定向检查，再运行全仓主要质量检查；纯文档改动核对事实、路径、链接与差异即可。交付时说明实际验证结果及未验证的环境依赖。
- 保持已有兼容标识：环境变量 `LA_PLUMA_*`、CSS 类名与 localStorage key `la-pluma-*`、HTTP 头 `x-la-pluma-*`、Agent API 标识 `la-pluma-agent-api`。品牌或目录重命名不能顺带改动这些对外约定。
- 子路径部署时，构建端 `VITE_BASE_PATH` 与运行端 `LA_PLUMA_BASE_PATH` 保持一致；`/api`、`/health` 与 `/webrtc-signaling` 仍使用同源根路径。
- `server/data/`、`server/debug/`、`.env*` 中的运行数据和凭据不入库；打包时保持运行数据与源码隔离。真实设备执行、调度或通知调试需处于当前任务授权范围内。
- 文档只保留现行约束与可复现方法；修改规则时更新其归属文档，其他位置保留导航。过程日志、一次性证据和性能原始采样不加入长期文档索引。移动文档时同步修复索引及源码、脚本中的引用。
- 维护本指南时只保留全局规则、必要命令与导航；子指南仅承载所在目录的独立规则，指南间引用保持自顶向下。普通文档不增加反向 AGENTS 引用。

## Git 规范

- 日常改动在主题分支开发，通过 Pull Request 合入 `main`。
- Commit message 使用英文并遵循 Conventional Commits，例如 `docs: document repository agent guidance`。
- 每个 commit 聚焦当前任务，不混入无关重构。
- Branch 使用 `<type>/<kebab-case-description>`，`<type>` 与本次主要修改类型一致；不使用 Agent、模型或工具名称作为 branch prefix。例如 `test/agent-server-callback-test`。
- `<type>` 优先采用 Development Guide 定义的 change type vocabulary。当前开发文档尚未列出该词表，采用 Git 历史已使用的 `build`、`chore`、`ci`、`docs`、`feat`、`fix`、`refactor`、`test`，不另造冲突规则。

## 延伸阅读

每项只在对应任务需要时读取；详细流程与契约以原文为单一事实来源。

| 入口 | 用途与阅读时机 |
| --- | --- |
| [客户端指南](client/AGENTS.md) | 修改 `client/` 时，了解前端分层、所有权、样式及专项验证 |
| [服务端指南](server/AGENTS.md) | 修改 `server/` 时，了解 API、执行、回调、持久化及测试边界 |
| [项目 README](README.md) | 首次安装、启动或准备真实设备联调 |
| [文档索引](docs/README.md) | 按任务查找领域契约、配置、部署及 API 文档 |
| [整体架构](docs/architecture/README.md) | 修改跨前后端边界或确认模块职责 |
| [开发指南](docs/development/README.md) | 查询检查方法、测试治理及工具约束 |
| [维护说明](docs/development/maintaining.md) | 发布、兼容性变更、外部运行时依赖或文档归属调整 |
| [部署指南](docs/guides/deployment.md) | 修改 Docker、HTTPS、反向代理、PWA 或子路径部署 |
| [CI 工作流](.github/workflows/ci.yml) | 调整质量门禁、镜像构建或发布时核对真实触发条件与 job 依赖 |
