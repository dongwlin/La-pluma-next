# 服务端架构与请求契约

> [← 返回文档索引](../README.md)

服务端是运行在 Node.js 上的 Express 应用：`server/src/app.ts` 装配请求管道并挂载路由，`server/src/server.ts` 负责 HTTP/HTTPS 传输、启动初始化与关闭。本文描述分层方向、请求管道、响应契约与测试入口；端点使用与错误码的完整说明见 [Agent API 使用指南](../api/agent.md)，执行与 Run 语义见[执行身份与生命周期契约](../architecture/execution-lifecycle.md)，后端组装概述见[架构与技术栈](../architecture/README.md)。

## 分层与依赖方向

服务端源码按单向分层组织：

```text
utils / config → services → controllers → routes → app.ts / server.ts
```

- `utils/`、`config/` 提供连接默认值、跨平台路径与响应、文件、日志等工具；`services/` 持有 MAA/ADB 子进程、Run、调度、通知等业务逻辑；`controllers/` 承接请求解析、校验与响应封装（含成功/失败 envelope 装配）；`routes/` 只做端点映射与 router 装配；`app.ts`/`server.ts` 是仅有的两个顶层入口（`server/AGENTS.md:7-15`、`server/scripts/guardrails.ts:90-123`）。`server/src/routes/agent.ts` 是 Agent API 聚合入口，只声明契约文档与领域 router 的挂载清单，不缓存运行状态、不直接发起副作用（`server/src/routes/agent.ts:16-31`）。
- 每层只允许导入同层或更低层，逐层允许目标表维护在 `server/scripts/guardrails.ts:106-112`；`scripts/` 是维护工具入口，可调用业务代码，业务代码不得依赖 `scripts`（`server/AGENTS.md:66`）。
- `pnpm --filter la-pluma-next-server guardrails` 是服务端唯一的静态正确性门禁，也是 `verify` 的第一步：`layer-inversion` 检查分层方向、`import-cycle` 检查静态 `import` / `export ... from` 成环、`unlayered-file` 要求新增顶层模块或目录先归入既有层，三者直接失败；`explicit-any`、`suppression-directive`、`double-assertion` 超出 `guardrails-baseline.json` 登记数即失败，存量例外逐条写明理由与移除条件。动态 `import()` 不参与环检查，静态环必须为零（`server/AGENTS.md:57-73`）。
- 测试与 fixture 不参与分层与依赖环检查，但仍检查类型逃生舱（`server/AGENTS.md:70`）。

## 请求管道（createLaPlumaApp）

`createLaPlumaApp(options)` 返回独立的 Express 应用，是唯一组装入口（`server/src/app.ts:53-168`）。中间件与挂载顺序：

1. 固定 `query parser` 为 `simple`：Express 5 的 `req.query` 是只读 getter，显式固定后查询参数保持单值扁平结构，不依赖嵌套对象解析（`server/src/app.ts:65-67`）。
2. CORS：`origin: '*'`，只声明浏览器可跨域读取响应，不承担鉴权；预检在鉴权之前应答。服务不使用 Cookie，也不支持浏览器凭据模式，跨域调用一律通过 token 头鉴权（`server/src/app.ts:89-92`）。
3. 请求 id 中间件，注册在鉴权与请求体解析之前（见下节；`server/src/app.ts:96`）。
4. 信令票据签发入口：注册在 JSON parser 之前，登录不读取业务请求体。无令牌时只接受同源签发，设置 `LA_PLUMA_TOKEN` 后由令牌把关；Express 5 通配符必须命名（`*splat`），信令路径本身与其余子路径一律返回固定 JSON 404，上游管理端点不经公共应用端口暴露（`server/src/app.ts:100-115`、`docs/api/agent.md:137`）。
5. `/health` 与 `/readiness` 探针（见「探针」）。
6. `/api` 命名空间：router 内先 `optionalApiAuth` 再 `express.json()`，鉴权先于 JSON 解析；依次挂载用户配置、Agent 聚合与干员台词路由后，未匹配路径返回统一 JSON 404 `AGENT_ROUTE_NOT_FOUND`，最后挂统一错误出口（`server/src/app.ts:137-146`）。
7. 生产静态资源：仅 `NODE_ENV=production` 时挂载。`/api`、`/health`、`/readiness` 与信令路径先经 `next('router')` 跳出命名空间；其余请求依次经 `express.static` 与 SPA fallback——无扩展名的路径返回 `index.html`；挂载点随 `LA_PLUMA_BASE_PATH` 的子路径偏移（`server/src/app.ts:148-166`）。

### 请求 id

请求头 `x-request-id` 可选；合法值为 1–64 位字母、数字与 `.`、`_`、`:`、`-`，首字符必须是字母或数字。合法值原样沿用，同一值出现在响应头 `x-request-id`、响应 `meta.requestId` 与该请求的日志上下文中；缺失、超长或含其他字符时丢弃客户端值并生成 UUID，不回显非法输入（`server/src/utils/requestContext.ts:15-64`）。中间件位于鉴权与请求体解析之前，因此 401/400 等前置失败、响应 meta 与同一请求的日志共用同一个 id（`server/src/app.ts:94-96`）。

### 认证与限流

- 设置 `LA_PLUMA_TOKEN` 后，信令票据入口与 `/api` 都需要令牌，未设置时认证关闭；`/health`、`/readiness` 不经过鉴权（`server/src/app.ts:68,81,105,138`、`server/src/utils/apiTokenAuth.ts:54-63`）。
- 令牌请求头、令牌比较、401/429 语义、认证失败与信令票据签发的限流阈值、窗口与来源判定的完整约定由[部署指南](../guides/deployment.md#跨域与访问来源)统一维护，本文不重复。
- 实现细节：令牌比较先对两侧做 SHA-256 摘要再 `timingSafeEqual`，401 响应带 `WWW-Authenticate`；限流键优先取 `req.ip`，来源条目数量有上限，窗口、阈值与时钟可在组装时注入（`server/src/utils/apiTokenAuth.ts:42-47,97-101`、`server/src/utils/loginThrottle.ts:45-66,90-109`、`server/src/app.ts:47-51`）。

## 响应 envelope 与错误码

`server/src/utils/apiHelper.ts` 定义统一 envelope（`server/src/utils/apiHelper.ts:63-81`）。成功与失败形态：

```json
{ "success": true, "message": "…", "data": { }, "meta": { "requestId": "…", "dryRun": false } }
```

```json
{ "success": false, "message": "…", "error": { "code": "…", "details": { }, "retryable": false }, "meta": { "requestId": "…", "dryRun": false } }
```

- `meta` 固定含 `requestId` 与 `dryRun`；`requestId` 优先取请求 id 中间件写入的 `req.id`，未经中间件的调用回退到同一套校验规则下的请求头（`server/src/utils/apiHelper.ts:123-133`）。dry-run 复用成功 envelope，`data` 为 `{ plan }` 且 `meta.dryRun: true`（`server/src/utils/apiHelper.ts:187-189`）。
- 业务错误用 `agentError(code, message, options)` 构造，公开字段固定为 `code`/`statusCode`/`details`/`retryable`；路由与控制器经 `asyncHandler` 把异步错误交给统一出口 `apiErrorHandler`（`server/src/utils/apiHelper.ts:135-143,212-222`）。

错误出口的归一规则（`server/src/utils/apiHelper.ts:309-344`）：已发送响应头则交回错误链；携带 400–599 状态的业务错误保留其公开 `code`、`message`、`details` 与 `retryable`，状态越界一律按 500 处理，`retryable` 只来自错误本身（`server/src/utils/apiHelper.ts:227-230,329-338`）；未知内部错误统一 500，不泄露内部 message、details 或堆栈；API 错误按级别记录，已归类的 4xx 记 WARN、5xx 记 ERROR，错误日志与响应不回显请求查询串（`server/src/utils/apiHelper.ts:278-300,340-343`）。

框架错误与入口层产生的稳定错误码：

| code | HTTP 状态 | 触发 |
| --- | --- | --- |
| `AGENT_ROUTE_NOT_FOUND` | 404 | `/api` 下未匹配路径（`server/src/app.ts:142-144`） |
| `AGENT_AUTH_REQUIRED` | 401 | 令牌模式开启且未携带有效令牌（`server/src/utils/apiTokenAuth.ts:98-101`） |
| `AGENT_RATE_LIMITED` | 429 | 认证失败次数超出窗口限制（`server/src/utils/apiTokenAuth.ts:85-94`） |
| `AGENT_REQUEST_BODY_INVALID` | 400 | 请求体不是有效 JSON（`server/src/utils/apiHelper.ts:244-247`） |
| `AGENT_REQUEST_BODY_TOO_LARGE` | 413 | 请求体超过允许大小（`server/src/utils/apiHelper.ts:250-253`） |
| `AGENT_REQUEST_CHARSET_UNSUPPORTED` | 415 | 请求字符集不支持（`server/src/utils/apiHelper.ts:256-259`） |
| `AGENT_REQUEST_PATH_INVALID` | 400 | 路径参数无法解码（`server/src/utils/apiHelper.ts:322-327`） |
| `AGENT_INTERNAL_ERROR` | 500 | 未识别的内部错误（`server/src/utils/apiHelper.ts:340-343`） |

## 探针：/health 与 /readiness

- `/health` 是存活探针，恒定返回 `{ success: true, status: 'ok' }`；容器存活检查继续使用它（`server/src/app.ts:117-119`）。
- `/readiness` 反映初始化、Run 存储与 draining：可就绪返回 200，否则 503；响应带 `Cache-Control: no-store`，`status`/`checks`/`reasons` 来自进程内快照，不探测 ADB/MAA 或外网，也不含路径、凭据与错误文本（`server/src/app.ts:124-133`）。就绪投影在组装入口绑定生命周期与 Run 存储状态：初始化失败后保持不可就绪，直到完成一次完整初始化；关闭开始（draining）后立即转为不可就绪（`server/src/server.ts:242-248,308-325`）。

## 传输与启动

`createLaPlumaServer(options)` 同步解析端口与 HTTPS 配置（提供有效 HTTPS 选项时用 `node:https`，否则 `node:http`）、组装生命周期与就绪投影，返回尚未监听的句柄；`start()` 幂等，按注册顺序执行 `agent-run-store`、`http-transport`（含信令网关挂载）与 `runtime-initialization`，执行收尾与预览关闭经各自挂接步骤参与，关闭顺序由注册顺序取反决定（`server/src/server.ts:228-241,260-325`）。关闭时先停止接受新连接并等待在途响应，keep-alive 连接在响应完成后立即释放，预算耗尽才强制断开全部连接（`server/src/server.ts:146-218`）。直接执行入口先安装 SIGINT/SIGTERM 处理再 `start()`：重复信号复用同一次关闭，关闭未完全成功以非零退出码退出；启动失败的回滚复用统一释放入口（`server/src/server.ts:327-372,386-451`）。

## 测试入口

- 测试使用 `node:test` 与 `node:assert/strict`，放在相关模块的 `__tests__/*.test.ts`，TS 测试同样只使用可擦除语法；发现规则只认 `__tests__` 目录下的 `.test.ts`，跳过 `data`、`debug` 与 `node_modules`（`server/AGENTS.md:52-53`、`server/scripts/testFiles.ts:14,19-35`）。
- HTTP 回归通过 `createLaPlumaApp` 组装应用，用临时监听器发起真实请求：`node:http` 的 `createServer` 包装应用并绑定 `127.0.0.1` 的端口 0，再对取得的地址发请求；不恢复调度、Telegram 或真实设备运行时（`server/src/__tests__/readiness.test.ts:59-71`、`server/AGENTS.md:35`）。
- 组装与启动均支持依赖注入：应用级可注入 env、信令网关、前端静态目录、用户配置存储、readiness 快照与限流参数（窗口、阈值、假时钟）（`server/src/app.ts:29-45`）；服务器级可注入 Run 存储初始化、运行时初始化、日志、关闭截止时间与执行收尾选项（`server/src/server.ts:60-72`）。

### 验证命令

以下命令从仓库根目录执行（`server/package.json`、`server/AGENTS.md:39-50`）：

| 目的 | 命令 |
| --- | --- |
| 类型与依赖护栏 | `pnpm --filter la-pluma-next-server guardrails` |
| 后端语法检查 | `pnpm --filter la-pluma-next-server check` |
| 后端类型检查 | `pnpm --filter la-pluma-next-server typecheck` |
| 后端回归 | `pnpm --filter la-pluma-next-server test` |
| 覆盖率检查 | `pnpm --filter la-pluma-next-server test:coverage` |
| 全部质量检查 | `pnpm --filter la-pluma-next-server verify` |

`test` 逐文件、逐进程执行测试，避免模块单例与环境变量相互污染；`test:coverage` 使用同一批测试文件与同样的进程隔离。定向回归可直接 `node --test` 单个测试文件，例如 `node --test server/src/services/__tests__/maaCallbackService.test.ts`（`server/scripts/run-tests.ts:6-9`、`server/scripts/testFiles.ts:4-8`、`server/AGENTS.md:46-50`）。

## 延伸阅读

- [服务端开发指南](../../server/AGENTS.md)：修改 `server/` 时的分层边界、执行与回调约束及验证命令。
- [Agent API 使用指南](../api/agent.md)：端点行为、幂等、鉴权与错误码的完整说明。
- [执行身份与生命周期契约](../architecture/execution-lifecycle.md)：Run 身份、停止、占用与持久化语义。
