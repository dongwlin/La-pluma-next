# 文档索引

> [← 返回 README](../README.md)

`docs/` 目录保存 La Pluma Next 的专题文档，覆盖架构、接口、功能、部署、配置、开发、组件库与维护流程。

根 README 负责安装与快速开始，本页提供其余文档的入口。UI 设计规范不在 `docs/` 下维护，统一见根目录 [DESIGN.md](../DESIGN.md)。

| 文档 | 内容 | 适合谁看 |
| --- | --- | --- |
| [前端职责与质量基线](frontend-baseline.md) | 八页 API/存储/副作用归属、状态生命期、视觉与性能复现 | 参与前端结构与状态迁移的贡献者 |
| [实时日志流生命周期](logs-realtime-stream.md) | 实时轮询与快照语义、单在途/旧响应裁决、Activity/文档可见性/手动暂停恢复、解析过滤折叠模型与回归入口 | 修改日志实时读取、暂停恢复或日志展示模型的开发者 |
| [历史日志与清理协调](logs-history-and-cleanup.md) | 实时/历史切换协议、历史列表/选择/读取竞态、Activity 恢复重试、清空实时与清理历史的缓存/列表/选择裁决 | 修改日志历史浏览、清理命令或相关生命周期的开发者 |
| [执行身份与生命周期契约](execution-lifecycle.md) | Run 身份、唯一状态来源、accepted/运行/停止/终态、断线/占用/manual/刷新/旧断点边界与入口覆盖 | 执行链路、Agent 集成与前端控制器开发者 |
| [前端执行客户端与控制器](execution-client.md) | 应用级控制器的公开面、幂等键/runId、快照观察、断线重连、停止与本地中止、页面迁移边界 | 执行控制器与前端执行迁移的开发者 |
| [配置同步与资源一致性契约](config-sync-and-invalidation.md) | 三页配置提交差异、pending/迟到加载/跨 remount 次序、跨页失效关系与 Dashboard 完整快照规则 | 修改配置持久化、缓存失效或 Dashboard 快照的开发者 |
| [配置持久化协调器](config-persistence.md) | 按 key 串行的协调模型、适配契约（编解码/迁移/完整提交）、薄 hooks、刷新与冲突边界、三域接入清单 | 迁移页面配置持久化或实现域适配器的开发者 |
| [设置配置编辑与保存](settings-config-editing.md) | MAA connection 的 Query 读取、草稿/revision、保存与重置边界、迟到读取裁决、section 存储/事件与清理 | 修改设置页配置表单、保存流程或 section 状态的开发者 |
| [设置设备连接与系统资源](settings-device-and-resources.md) | 设备发现/连接测试命令所有者、取消与草稿回填 revision、版本/配置目录 Query、打开目录入口与 Activity 行为 | 修改设置页设备面板、版本或配置目录读取的开发者 |
| [设置组件更新与自动更新](settings-updates-and-auto-update.md) | core/CLI/资源更新命令的互斥、失败重试与 Activity 行为、更新后版本与跨域资源失效、自动更新草稿/本地回退/完整提交 | 修改设置页组件更新、资源失效或自动更新策略的开发者 |
| [资源请求错误与取消契约](resource-requests.md) | 只读资源的 AbortSignal 传递、信封与领域载荷校验、失败分类、取消/停止/撤销边界、候选端点与 Query 迁移入口 | 迁移资源查询、缓存或处理请求失败的前端开发者 |
| [Query 缓存与键规范](query-cache.md) | 应用级 Query 客户端、默认重取/重试/Activity 策略、领域 key 与失效规范、Dashboard 快照边界 | 迁移资源读取或实现缓存失效的前端开发者 |
| [总览完整快照与设备采样](dashboard-snapshot.md) | 五路业务读取的领域 Query、完整快照归一/原子提交/失败保旧、设备采样轮询与 Activity 恢复、失效与执行入口 | 修改总览数据、刷新协调或设备采样的开发者 |
| [肉鸽领域面板](roguelike-panel.md) | 页面/工作区/面板的组合边界、模式与配置/执行状态归属、任务目录与命令/校验纯模型、Activity 与兼容 | 修改肉鸽页面结构、表单字段或命令拼接的开发者 |
| [统计数据领域面板](statistics-panel.md) | 页面/工作区/干员/仓库/掉落面板的组合边界、筛选菜单 portal/焦点/键盘、面板局部状态生命期、仓库汇总与掉落排序纯模型 | 修改统计页面结构、筛选交互或识别结果展示的开发者 |
| [作业搜索与预览](combat-search-preview.md) | 普通/悖论搜索、单作业与作业集详情的资源身份、取消与旧响应裁决、计划优先/成员回退、选段与命令模型 | 修改作业搜索、预览或执行选择接线的开发者 |
| [共享资源归属与失效端口](resource-ownership.md) | game-data 共享资源域、training/statistics 去环后的依赖方向、图标与资源缓存策略、跨域失效端口与未迁移页面接收 | 迁移共享资源、写入后失效或页面读取的前端开发者 |
| [统计识别命令与失效联动](statistics-commands.md) | 识别/材料命令所有者、执行控制器与幂等回放、日志解析等待、超时/取消/继续、识别后作用域失效 | 迁移页面命令、处理识别结果或调整命令超时与失效联动的开发者 |
| [养成队列命令与写后刷新](training-queue-commands.md) | 队列增删排序撤销的串行命令、写后刷新与不确定 fallback、队列 revision、跨页失效与 Dashboard 联动 | 修改养成队列写入、撤销或队列缓存失效的开发者 |
| [养成设置提交与计划有效期](training-settings-and-plan-validity.md) | 设置的串行提交与本地 revision、旧响应裁决、计划 basis、生成/应用/同步所有者、配置写入屏障与跨页失效 | 修改养成设置、计划生成/应用或相关页面接线的开发者 |
| [架构与技术栈](architecture.md) | 整体架构、前后端边界、技术栈和项目结构 | 需要理解前后端边界与代码组织的新开发者 |
| [Agent API 使用指南](agent-api.md) | manifest/status/actions、推荐执行流程、幂等、持久化与鉴权 | 对接 `/api/agent` 的 Agent、脚本与集成开发者 |
| [功能概览](features.md) | 控制台、自动化流程、定时任务、作业与肉鸽、数据养成、Telegram 通知 | 新用户与需要确认能力范围的用户 |
| [部署指南](deployment.md) | GHCR 镜像、环境变量、HTTPS/PWA、子路径、Docker Compose 与本地构建 | 负责部署与运维的人员 |
| [配置与跨平台支持](configuration.md) | 运行平台与配置路径、ADB 连接、Telegram 通知与 Bot 命令 | 首次配置环境或排查连接问题的用户 |
| [开发文档](development.md) | 主要技术点与常用检查命令 | 参与开发与提交 PR 的贡献者 |
| [通用组件库](component-library.md) | 通用组件 API、用法与页面重构清单 | 前端开发者与 UI 贡献者 |
| [维护说明](maintaining.md) | 分支与合并、发布流程、容器镜像、兼容性标识与外部运行时依赖 | 仓库维护者与发布负责人 |
