# 服务端开发指南

## 职责与组织

服务端运行在 Node.js 24.12+ 上，JavaScript ESM 与 TypeScript 混合：Node 原生类型擦除直接运行 `.ts`，生产不经过编译器。JS 相对导入保留 `.js` 扩展名；TS 相对导入使用真实 `.ts` 扩展名，且只使用可擦除语法（不用 `enum`、`namespace`、构造器参数属性和 `import =`）。类型门禁以 `tsc --noEmit` 独立执行（NodeNext、strict、noEmit、erasableSyntaxOnly、verbatimModuleSyntax，固定 TypeScript 6.0.3），只检查 TS 文件；过渡期 JS 文件经 `allowJs` 纳入程序但不做类型检查，未检查 JS 的清单与数量由 `typecheck` 脚本输出。服务文件、函数与变量使用现有的 camelCase 命名。

| 位置 | 修改边界 |
| --- | --- |
| `server.js` | HTTP/HTTPS、认证、生产静态资源、WebRTC 信令网关与启动初始化 |
| `routes/` | 请求归一化、校验、响应与执行入口；`agent.js` 聚合领域 router，tracked 执行、流程/作业集与目标停止在 `agentExecution.js` |
| `services/` | MAA/ADB 子进程、Run、调度、作业集、养成、通知及领域解析 |
| `config/`、`utils/` | 连接默认值、跨平台路径与响应、文件、日志工具 |
| `scripts/` | 语法检查、类型检查、测试入口与游戏数据获取脚本 |

- 路由沿用 `asyncHandler`、`sendSuccess`、`sendError` 与结构化 `agentError`；保留现有错误码、HTTP 状态和兼容响应字段。
- 向 Agent 公开能力时更新 `routes/agentContract.js`；manifest 与 OpenAPI 从同一能力清单生成，不分别维护副本。Web UI 专用入口不必全部加入 manifest。
- 新业务逻辑放入对应 service，路由负责适配；回调解析与结果格式化沿用独立的 `*ResultService.js`，避免继续堆入执行编排。

## 执行与回调边界

修改设备执行、Run、停止或调度前，先阅读延伸阅读中的生命周期契约。

- Run 负责执行身份与终态；`maaService` 的子进程状态、调度步骤和设备租约是不同投影。子进程 idle、HTTP 结束或读取失败不能直接作为整个流程完成的依据。
- 设备变更复用 `executionCoordinatorService.js` 的租约；保持获得租约后、产生设备副作用前的 `startAgentRunForExecution` 门禁。后台执行不能在返回接受响应时释放租约或写成功终态；须由实际进程退出结果收尾。
- 按 `runId` 停止必须保留目标校验、重复停止和旧终态保护，避免旧请求停止后续执行；流程停止后不得启动下一步。
- 解析 MAA 回调时复用 `maaCallbackService.js`，按 `taskchain` 过滤结构化载荷并容忍不完整行。调度中的回调结果读取使用执行前检查点与增量日志，不能把旧任务日志算入当前结果；领域结果中的 `skipped`、`failed` 与 `success` 不可混同。

## 持久化与运行时

- Run 与幂等记录默认写入 `data/agent-runs.json`，仅支持单服务实例；不得让多个 Node 进程共用该文件。存储损坏或写入失败时维持执行准入关闭，不删文件绕过。重启恢复的是记录，活动 Run 转为 `interrupted`，不会自动续跑。正常关闭先进入 draining，经统一准入闸门拒绝新执行，停止本实例的活动执行并在退出前等待 Run 落盘。
- 用户配置通过 `configStorageService.js` 的类型白名单读写；新增配置类型须同步校验。连接参数沿用 `connectionService.js` 的 profile 解析与覆盖策略；资源和日志路径复用现有 getter，保留跨平台及 XDG 行为。
- 配置保存、定时任务注册与实际执行是不同操作。养成计划应用必须校验 `queueRevision`，保留队列已保存但流程/定时同步失败的结果，不能将部分成功伪装成全成功。
- 启动服务会恢复已保存的定时任务、自动更新和 Telegram 配置；测试 HTTP 行为优先使用 `createLaPlumaApp` 或注入初始化依赖，避免启动真实运行时。WebRTC 浏览器入口继续经过同源信令网关，不暴露上游管理端点。

## 验证

以下命令从仓库根目录执行：

| 目的 | 命令 |
| --- | --- |
| 后端语法检查 | `pnpm --filter la-pluma-next-server check` |
| 后端类型检查 | `pnpm --filter la-pluma-next-server typecheck` |
| 后端回归 | `pnpm --filter la-pluma-next-server test` |
| 定向回归示例 | `node --test server/services/__tests__/maaCallbackService.test.js` |
| 覆盖率检查 | `pnpm --filter la-pluma-next-server test:coverage` |

`build` 仅执行语法检查；类型检查由 `typecheck` 独立承担，覆盖范围内的 TS 文件并输出未检查 JS 清单（`tsconfig.json` 的 `include`/`exclude` 为静态范围声明）；后端未配置独立的 Lint 与 Format。常规测试入口逐文件、逐进程串行运行；不要为提速随意改成共享进程并行，以免模块单例和环境变量相互污染。

- 测试使用 `node:test` 与 `node:assert/strict`，放在相关模块的 `__tests__/*.test.js` 或 `*.test.ts`；新增文件须符合测试入口的发现规则，TS 测试同样只使用可擦除语法。
- 执行、持久化或子进程测试沿用临时目录、假 CLI 和依赖注入；隔离 Run 存储、执行锁、养成数据等路径，清理单例并恢复环境变量。模块导入时读取的环境变量须在导入前设置。
- 修改行为或修复 Bug 时补对应的契约/回归场景，尤其是停止竞态、后台失败、存储失败、重启恢复及部分同步失败；修改后运行定向回归及后端语法检查、完整回归。
- 数据获取脚本访问外部数据源并重写数据文件，不能作为普通验证步骤运行。

## 延伸阅读

- [服务端脚本与依赖](package.json)：查阅可执行脚本和依赖时读取，以实际配置为准。
- [执行身份与生命周期契约](../docs/architecture/execution-lifecycle.md)：修改执行身份、租约、停止、幂等、持久化或快照时必读；含契约测试分工。
- [Agent API 使用指南](../docs/api/agent.md)：新增或修改公开接口、响应、连接参数及养成同步行为时读取。
