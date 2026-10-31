# 服务端开发指南

## 职责与组织

服务端运行在 Node.js 24.12+ 上，源码全部为 TypeScript ESM：Node 原生类型擦除直接运行 `.ts`，生产不经过编译器。相对导入使用真实 `.ts` 扩展名，且只使用可擦除语法（不用 `enum`、`namespace`、构造器参数属性和 `import =`）。类型门禁以 `tsc --noEmit` 独立执行（NodeNext、strict、noEmit、erasableSyntaxOnly、verbatimModuleSyntax，固定 TypeScript 6.0.3），覆盖 `server/**/*.ts`；`allowJs` 已移除，源码目录出现 `.js` / `.mjs` / `.cjs` 时 `typecheck` 直接失败，避免未检查文件被 tsc 全绿掩盖。`guardrails` 检查显式 `any`、类型抑制指令、经 any/unknown 的双重断言、分层方向与静态导入环；存量例外登记在 `guardrails-baseline.json`，每条含理由与移除条件。服务文件、函数与变量使用现有的 camelCase 命名。

| 位置 | 修改边界 |
| --- | --- |
| `src/app.ts` | Express 应用装配：CORS、请求 id、认证与限流、信令登录入口、生产静态资源与路由挂载；`createLaPlumaApp` 是唯一组装入口 |
| `src/server.ts` | HTTP/HTTPS 传输、WebRTC 信令网关挂载、启动初始化与关闭处理 |
| `src/routes/` | 路径映射与 router 装配：`agent.ts` 只做契约文档与领域 router 聚合；tracked 执行、状态与 Run 查询、日志、掉落与游戏数据读取、养成队列与计划、预览截图/WebRTC/方向与设备采样、通知频道配置与发送、连接/profile/资源更新/定时配置与维护动作分别在 `agentExecution.ts`、`agentStatusRoutes.ts`、`agentLogRoutes.ts`、`agentDataRoutes.ts`、`agentTrainingRoutes.ts`、`agentPreviewRoutes.ts`、`agentNotificationRoutes.ts`、`agentMaintenanceRoutes.ts`，各 router 只做端点映射 |
| `src/controllers/` | 请求解析、校验与响应封装（含成功/失败 envelope 装配）：各领域 `*Controller.ts` 按域承接对应 router 的 req/res 适配并自行写响应，`/status` 探测合并与短缓存在此层；请求/响应 DTO（`readDto.ts` 读取域共享助手与掉落/游戏数据载荷、`statusDto.ts` /status 响应载荷与 Run 查询请求、`logDto.ts` 日志请求收窄与清理输入、`executionDto.ts`、`maintenanceDto.ts`、`previewDto.ts`、`notificationDto.ts`、`trainingDto.ts`、`operatorQuotesDto.ts`）与共享适配（`deviceStatus.ts`、`requestConnection.ts`、`configStorageError.ts`）也归此层 |
| `src/services/` | MAA/ADB 子进程、Run、调度、作业集、养成、通知及领域解析 |
| `src/config/`、`src/utils/` | 连接默认值、跨平台路径与响应、文件、日志工具 |
| `scripts/` | 语法检查、类型检查、类型与依赖护栏、测试/覆盖率入口与游戏数据获取脚本 |

- 路由与控制器沿用 `asyncHandler`、`sendSuccess`、`sendError` 与结构化 `agentError`；保留现有错误码、HTTP 状态和兼容响应字段。
- 向 Agent 公开能力时更新 `src/routes/agentContract.ts`；manifest 与 OpenAPI 从同一能力清单生成，不分别维护副本。Web UI 专用入口不必全部加入 manifest。
- 新业务逻辑放入对应 service，请求适配与 envelope 装配由对应领域控制器承担，路由只做端点映射；回调解析与结果格式化沿用独立的 `*ResultService.ts`，避免继续堆入执行编排。

## 执行与回调边界

修改设备执行、Run、停止或调度前，先阅读延伸阅读中的生命周期契约。

- Run 负责执行身份与终态；`maaProcessService` 的子进程状态、调度步骤和设备租约是不同投影。子进程 idle、HTTP 结束或读取失败不能直接作为整个流程完成的依据。
- 设备变更复用 `executionCoordinatorService.ts` 的租约；保持获得租约后、产生设备副作用前的 `startAgentRunForExecution` 门禁。后台执行不能在返回接受响应时释放租约或写成功终态；须由实际进程退出结果收尾。
- 按 `runId` 停止必须保留目标校验、重复停止和旧终态保护，避免旧请求停止后续执行；流程停止后不得启动下一步。
- 解析 MAA 回调时复用 `maaCallbackService.ts`，按 `taskchain` 过滤结构化载荷并容忍不完整行。调度中的回调结果读取使用执行前检查点与增量日志，不能把旧任务日志算入当前结果；领域结果中的 `skipped`、`failed` 与 `success` 不可混同。

## 持久化与运行时

- Run 与幂等记录默认写入 `data/agent-runs.json`，仅支持单服务实例；不得让多个 Node 进程共用该文件。存储损坏或写入失败时维持执行准入关闭，不删文件绕过。重启恢复的是记录，活动 Run 转为 `interrupted`，不会自动续跑。正常关闭先进入 draining，经统一准入闸门拒绝新执行，停止本实例的活动执行并在退出前等待 Run 落盘。
- 用户配置通过 `configStorageService.ts` 的类型白名单读写；新增配置类型须同步校验。连接参数沿用 `connectionService.ts` 的 profile 解析与覆盖策略；资源和日志路径复用现有 getter，保留跨平台及 XDG 行为。
- 配置保存、定时任务注册与实际执行是不同操作。养成计划应用必须校验 `queueRevision`，保留队列已保存但流程/定时同步失败的结果，不能将部分成功伪装成全成功。
- 启动服务会恢复已保存的定时任务、自动更新和 Telegram 配置；测试 HTTP 行为优先使用 `createLaPlumaApp` 或注入初始化依赖，避免启动真实运行时。WebRTC 浏览器入口继续经过同源信令网关，不暴露上游管理端点。

## 验证

以下命令从仓库根目录执行：

| 目的 | 命令 |
| --- | --- |
| 后端语法检查 | `pnpm --filter la-pluma-next-server check` |
| 后端类型检查 | `pnpm --filter la-pluma-next-server typecheck` |
| 类型与依赖护栏 | `pnpm --filter la-pluma-next-server guardrails` |
| 后端回归 | `pnpm --filter la-pluma-next-server test` |
| 定向回归示例 | `node --test server/src/services/__tests__/maaCallbackService.test.ts` |
| 覆盖率检查 | `pnpm --filter la-pluma-next-server test:coverage` |

`build` 仅执行语法检查（`node --check` 逐个解析 `.ts`，同时拒绝不可擦除语法，不依赖 TypeScript 编译器，只装生产依赖时也能运行）；类型检查由 `typecheck` 独立承担，覆盖全部 TS 文件（`tsconfig.json` 的 `include`/`exclude` 为静态范围声明）；`guardrails` 承担类型与依赖职责检查，只约束正确性不变量，不引入格式或风格规则。`verify` 依次运行 `guardrails`、`check`、`typecheck`、`test`。常规测试入口逐文件、逐进程串行运行；不要为提速随意改成共享进程并行，以免模块单例和环境变量相互污染。`test:coverage` 与 `test` 使用同一批测试文件和同样的逐文件进程隔离，统计范围固定为 `**/*.ts` 排除 `**/__tests__/**`，阈值是只升不降的渐进下限；Node 只统计被测试加载过的文件，覆盖率不能替代行为测试。

- 测试使用 `node:test` 与 `node:assert/strict`，放在相关模块的 `__tests__/*.test.ts`；新增文件须符合测试入口的发现规则，TS 测试同样只使用可擦除语法。
- 执行、持久化或子进程测试沿用临时目录、假 CLI 和依赖注入；隔离 Run 存储、执行锁、养成数据等路径，清理单例并恢复环境变量。模块导入时读取的环境变量须在导入前设置。
- 修改行为或修复 Bug 时补对应的契约/回归场景，尤其是停止竞态、后台失败、存储失败、重启恢复及部分同步失败；修改后运行定向回归及后端语法检查、完整回归。
- 数据获取脚本访问外部数据源并重写数据文件，不能作为普通验证步骤运行。

## 类型与依赖护栏

`pnpm --filter la-pluma-next-server guardrails` 是服务端唯一的静态正确性门禁（不检查格式或风格），也是 `verify` 的第一步：

| 规则 | 约束 | 失败方式 |
| --- | --- | --- |
| `explicit-any` | 不新增显式 `any` | 超出基线即失败 |
| `suppression-directive` | 不使用 `@ts-` 抑制指令 | 超出基线即失败 |
| `double-assertion` | 不写经 `any` / `unknown` 的双重断言 | 超出基线即失败 |
| `layer-inversion` | `utils` / `config` → `services` → `controllers` → `routes` → `app.ts` / `server.ts` 单向；`scripts` 可调用业务代码，业务代码不得依赖 `scripts` | 直接失败 |
| `import-cycle` | 静态 `import` / `export ... from` 不得成环 | 直接失败 |
| `unlayered-file` | 新增顶层模块或目录必须先归入既有层 | 直接失败 |

- 范围是 `server/**/*.ts`；测试与 fixture 不参与分层与依赖环，但仍检查类型逃生舱。
- 动态 `import()` 不参与环检查：它用于延迟加载重模块或有意断开静态环（养成应用与调度、执行端口与数据解析），静态环本身必须为零。
- 存量例外登记在 `guardrails-baseline.json`，每条写清 `reason` 与 `remove`（移除条件）；违规数下降后应下调 `count`，护栏会提示可下调项。
- 同一命令核对 TypeScript 版本三处一致：`package.json` 的精确声明、根 `pnpm-lock.yaml` 的 server importer、实际安装的编译器。

## 延伸阅读

- [服务端脚本与依赖](package.json)：查阅可执行脚本和依赖时读取，以实际配置为准。
- [服务端架构与请求契约](../docs/server/README.md)：调整分层方向、请求管道、响应契约或测试入口时读取。
- [运行时初始化、就绪与关闭](../docs/server/runtime-lifecycle.md)：修改启动组装、就绪判定、执行准入或关闭流程时必读。
- [持久化与运行数据](../docs/server/persistence.md)：新增持久化数据、调整写入或恢复语义前必读。
- [日常流程与定时触发](../docs/server/scheduling.md)：修改任务流计划、流程执行或定时注册时必读。
- [MAA、ADB 与通知渠道](../docs/server/integrations.md)：调整 MAA 子进程、连接解析、回调解析或通知渠道时读取。
- [设备预览与信令运行时](../docs/server/preview-webrtc.md)：修改预览链路、信令网关或 WebRTC 运行时前必读。
- [执行身份与生命周期契约](../docs/architecture/execution-lifecycle.md)：修改执行身份、租约、停止、幂等、持久化或快照时必读；含契约测试分工。
- [Agent API 使用指南](../docs/api/agent.md)：新增或修改公开接口、响应、连接参数及养成同步行为时读取。
