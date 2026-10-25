# 文档索引

> [← 返回 README](../README.md)

`docs/` 目录保存 La Pluma Next 的专题文档，覆盖架构、接口、功能、部署、配置、开发、组件库与维护流程。

根 README 负责安装与快速开始，本页提供其余文档的入口。UI 设计规范不在 `docs/` 下维护，统一见根目录 [DESIGN.md](../DESIGN.md)。

| 文档 | 内容 | 适合谁看 |
| --- | --- | --- |
| [前端职责与质量基线](frontend-baseline.md) | 八页 API/存储/副作用归属、状态生命期、视觉与性能复现 | 参与前端结构与状态迁移的贡献者 |
| [架构与技术栈](architecture.md) | 整体架构、前后端边界、技术栈和项目结构 | 需要理解前后端边界与代码组织的新开发者 |
| [Agent API 使用指南](agent-api.md) | manifest/status/actions、推荐执行流程、幂等、持久化与鉴权 | 对接 `/api/agent` 的 Agent、脚本与集成开发者 |
| [功能概览](features.md) | 控制台、自动化流程、定时任务、作业与肉鸽、数据养成、Telegram 通知 | 新用户与需要确认能力范围的用户 |
| [部署指南](deployment.md) | GHCR 镜像、环境变量、HTTPS/PWA、子路径、Docker Compose 与本地构建 | 负责部署与运维的人员 |
| [配置与跨平台支持](configuration.md) | 运行平台与配置路径、ADB 连接、Telegram 通知与 Bot 命令 | 首次配置环境或排查连接问题的用户 |
| [开发文档](development.md) | 主要技术点与常用检查命令 | 参与开发与提交 PR 的贡献者 |
| [通用组件库](component-library.md) | 通用组件 API、用法与页面重构清单 | 前端开发者与 UI 贡献者 |
| [维护说明](maintaining.md) | 分支与合并、发布流程、容器镜像、兼容性标识与外部运行时依赖 | 仓库维护者与发布负责人 |
