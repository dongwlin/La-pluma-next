import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Server as HttpsServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { printPathConfig } from './config/paths.ts';
import {
  loadHttpsOptions,
  normalizeBasePath,
  parsePort,
  resolveAppPaths
} from './config/runtimeConfig.ts';
import type { AppPaths, ReadFileSyncLike, RuntimeEnvSource } from './config/runtimeConfig.ts';
import operatorQuotesRoutes from './routes/operatorQuotes.ts';
import agentRoutes from './routes/agent.ts';
import { createUserConfigRouter } from './routes/userConfig.ts';
import {
  getAgentRunStoreStatus,
  initializeAgentRunStore
} from './services/agentRunService.ts';
import type { AgentRunStoreRestoreSummary } from './services/agentRunService.ts';
import { initializeRuntimeState } from './services/runtimeInitializationService.ts';
import type { RuntimeInitializationOverrides } from './services/runtimeInitializationService.ts';
import { closeExecutionAdmission } from './services/executionAdmissionService.ts';
import { attachExecutionShutdownToLifecycle } from './services/executionShutdownService.ts';
import type {
  ExecutionShutdownOptions,
  ExecutionShutdownService
} from './services/executionShutdownService.ts';
import { createRuntimeReadinessTracker } from './services/runtimeReadinessService.ts';
import type { RuntimeReadinessTracker } from './services/runtimeReadinessService.ts';
import {
  DEFAULT_CLOSE_DEADLINE_MS,
  createRuntimeLifecycle
} from './services/runtimeLifecycleService.ts';
import type {
  RuntimeLifecycle,
  RuntimeLifecycleCloseSummary,
  RuntimeLifecycleLogger
} from './services/runtimeLifecycleService.ts';
import { createSignalingLoginGuard } from './services/signalingLoginGuard.ts';
import {
  createWebrtcSignalingGateway,
  WEBRTC_SIGNALING_PATH
} from './services/webrtcSignalingGateway.ts';
import type { WebrtcSignalingGateway } from './services/webrtcSignalingGateway.ts';
import { attachWebrtcPreviewToLifecycle } from './services/webrtcService.ts';
import { resolveWebrtcCredentials } from './config/webrtcCredentials.ts';
import { agentError, apiErrorHandler, sendError } from './utils/apiHelper.ts';
import { createOptionalApiAuth } from './utils/apiTokenAuth.ts';
import { createLoginThrottle } from './utils/loginThrottle.ts';
import { requestIdMiddleware } from './utils/requestContext.ts';
import type { UserConfigStorage } from './services/configStorageService.ts';

// 供 isMainModule 判断使用；应用内路径解析已由 config 入口按模块位置锚定
const __filename = fileURLToPath(import.meta.url);

// 组装入口的配置解析归属 config 模块；此处保留导出供既有使用者与测试引用
export { loadHttpsOptions, normalizeBasePath } from './config/runtimeConfig.ts';

/** 认证失败与票据签发的限流窗口；测试可注入更小阈值与假时钟。 */
export interface LoginRateLimitOptions {
  windowMs?: number;
  maxAuthFailures?: number;
  maxSignalingLogins?: number;
  now?: () => number;
}

/** 应用组装选项：运行配置、传输网关与测试注入口。 */
export interface CreateLaPlumaAppOptions {
  env?: RuntimeEnvSource;
  signalingGateway?: WebrtcSignalingGateway;
  clientDistPath?: string;
  userConfigStorage?: UserConfigStorage;
  readiness?: RuntimeReadinessTracker;
  loginRateLimit?: LoginRateLimitOptions;
}

/** 组装日志端口：与既有调用一致，warn 可缺省。 */
export interface ServerLogger {
  log(message: string, data?: unknown): unknown;
  warn?(message: string, data?: unknown): unknown;
  error(message: string, data?: unknown): unknown;
}

/** 启动选项：生命周期预算、运行依赖注入口与应用路径覆盖。 */
export interface StartLaPlumaServerOptions {
  env?: RuntimeEnvSource;
  host?: string;
  port?: number;
  signalingGateway?: WebrtcSignalingGateway;
  initializeRunStore?: () => Promise<AgentRunStoreRestoreSummary>;
  /** 运行时恢复端口；真实实现接收生命周期端口，测试可只返回 Promise。 */
  initializeRuntime?: (overrides: RuntimeInitializationOverrides) => unknown;
  logger?: ServerLogger;
  closeDeadlineMs?: number;
  executionShutdownOptions?: ExecutionShutdownOptions;
  appPaths?: AppPaths;
}

/** 组装完成后的运行句柄：应用、传输、生命周期与统一关闭入口。 */
export interface LaPlumaRuntime {
  app: Express;
  server: HttpServer | HttpsServer;
  protocol: 'http' | 'https';
  port: number;
  lifecycle: RuntimeLifecycle;
  readiness: RuntimeReadinessTracker;
  executionShutdown: ExecutionShutdownService | null;
  close(reason?: string): Promise<RuntimeLifecycleCloseSummary>;
}

/** 关闭处理器读取的结果：整体成功位与步骤状态。 */
export interface ShutdownStepOutcome {
  name: string;
  status: string;
  error?: string;
}

export interface ShutdownOutcome {
  ok?: boolean;
  steps?: readonly ShutdownStepOutcome[];
}

/** 关闭处理器只要求运行时提供 close；测试可注入更小的关闭端口。 */
export interface ShutdownRuntime {
  close(reason?: string): Promise<ShutdownOutcome>;
}

export interface ShutdownHandlerOptions {
  logger?: RuntimeLifecycleLogger;
  exit?: (code: number) => void;
  signals?: readonly NodeJS.Signals[];
}

function getLocalIpAddress(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 单实例限流窗口：认证失败与票据签发分别计数，均按来源地址隔离。
// 阈值只防暴力尝试，正常预览一次会话通常只登录一次。
const AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_AUTH_FAILURES_PER_WINDOW = 10;
const MAX_SIGNALING_LOGINS_PER_WINDOW = 30;

export function createLaPlumaApp({
  env = process.env,
  signalingGateway = createWebrtcSignalingGateway(),
  clientDistPath = resolveAppPaths().frontendDistDir,
  userConfigStorage,
  readiness = createRuntimeReadinessTracker(),
  loginRateLimit = {}
}: CreateLaPlumaAppOptions = {}): Express {
  if (typeof readiness?.snapshot !== 'function') {
    throw new TypeError('readiness 必须提供 snapshot()');
  }
  const app = express();
  // Express 5 的 req.query 是只读 getter；显式固定 simple 解析器，
  // 让查询参数保持单值扁平结构，不依赖嵌套对象解析。
  app.set('query parser', 'simple');
  const apiToken = env.LA_PLUMA_TOKEN || '';
  // 认证失败与票据签发共享窗口长度、各自计数；测试可注入更小阈值与假时钟。
  const rateLimitWindowMs = loginRateLimit.windowMs ?? AUTH_RATE_LIMIT_WINDOW_MS;
  const authFailureThrottle = createLoginThrottle({
    windowMs: rateLimitWindowMs,
    maxAttempts: loginRateLimit.maxAuthFailures ?? MAX_AUTH_FAILURES_PER_WINDOW,
    now: loginRateLimit.now
  });
  const signalingLoginThrottle = createLoginThrottle({
    windowMs: rateLimitWindowMs,
    maxAttempts: loginRateLimit.maxSignalingLogins ?? MAX_SIGNALING_LOGINS_PER_WINDOW,
    now: loginRateLimit.now
  });
  const optionalApiAuth = createOptionalApiAuth({ token: apiToken, failureThrottle: authFailureThrottle });
  const signalingLoginGuard = createSignalingLoginGuard({ token: apiToken, throttle: signalingLoginThrottle });
  const signalingPath = signalingGateway.proxyPath || WEBRTC_SIGNALING_PATH;
  const basePath = normalizeBasePath(env.LA_PLUMA_BASE_PATH);

  // CORS 只声明浏览器可跨域读取响应，不承担鉴权；预检必须在鉴权之前应答，
  // 因此 cors 位于所有路由之前。服务不使用 Cookie，也不支持浏览器凭据模式
  // （credentials: 'include'），跨域调用一律通过 token 头鉴权。
  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }));

  // 请求 id 在鉴权与请求体解析之前建立：401/400 等前置失败、响应 meta 与
  // 同一请求的日志都使用同一个 id。客户端值需通过长度与字符集校验，否则丢弃重发。
  app.use(requestIdMiddleware);

  // Only ticket issuance is exposed over HTTP. The signaling admin UI and
  // device endpoints remain inaccessible through the public application port.
  // 登录不依赖业务请求体：注册在 JSON parser 之前，handleLogin 只丢弃请求流。
  // 令牌模式由 optionalApiAuth 把关；无令牌的本地/LAN 模式只允许同源签发，
  // 并对签发频率限流，避免跨站页面换取设备控制票据或刷上游登录。
  app.post(
    `${signalingPath}/api/login`,
    optionalApiAuth,
    signalingLoginGuard,
    async (req: Request, res: Response): Promise<void> => {
      // 统一包装为 void 返回：上游登录失败仍交给 Express 错误出口处理。
      await signalingGateway.handleLogin(req, res);
    }
  );
  // Express 5 通配符必须命名（*splat），捕获值在 req.params.splat 中为路径段数组；
  // 本路径与子路径的隐藏策略不变：除 ticket 签发外一律返回固定 404。
  app.all(signalingPath, (_req, res) => res.status(404).json({ error: 'Not Found' }));
  app.all(`${signalingPath}/*splat`, (_req, res) => res.status(404).json({ error: 'Not Found' }));

  // API 鉴权先于请求体解析：未携带有效 token 的请求在读取请求体之前即被拒绝。
  app.use('/api', optionalApiAuth);
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ success: true, status: 'ok' });
  });

  // 就绪状态与存活分离：/health 只表示进程仍在运行（容器存活检查继续使用），
  // /readiness 反映初始化、Run 存储与 draining，不可就绪时返回 503。
  // 快照只读进程内状态，不探测 ADB/MAA 或外网；响应不含路径、凭据与错误文本。
  app.get('/readiness', (_req, res) => {
    const snapshot = readiness.snapshot();
    res.set('Cache-Control', 'no-store');
    res.status(snapshot.ready ? 200 : 503).json({
      success: snapshot.ready,
      status: snapshot.status,
      checks: snapshot.checks,
      reasons: snapshot.reasons
    });
  });

  if (env.NODE_ENV === 'production') {
    const staticMountPath = basePath === '/' ? '/' : basePath.slice(0, -1);
    const reservedPaths = ['/api', '/health', '/readiness', signalingPath];
    const sendAppShell = (req: Request, res: Response, next: NextFunction): void => {
      const appPath = staticMountPath === '/'
        ? req.path
        : req.path.slice(staticMountPath.length) || '/';
      if (reservedPaths.some(path => appPath === path || appPath.startsWith(`${path}/`))) {
        return next();
      }
      if (extname(req.path)) return next();
      res.sendFile(join(clientDistPath, 'index.html'));
    };

    app.use(staticMountPath, express.static(clientDistPath));
    // SPA fallback 使用可选命名通配符 {*splat}：根部署同时覆盖 / 与深链接，
    // 子路径部署不匹配挂载根本身（由 static 中间件重定向到带斜杠路径），与旧 '*'
    // 语法在 Express 4 下的匹配范围一致。
    if (basePath === '/') app.get('/{*splat}', sendAppShell);
    else app.get(`${staticMountPath}/{*splat}`, sendAppShell);
  }

  // 用户配置 HTTP 适配独立挂载；存储实例由应用组装注入，缺省使用默认存储。
  // 鉴权与 JSON 解析仍由 /api 前置中间件承担，错误继续交给统一出口。
  app.use('/api/agent/config/user', createUserConfigRouter({ storage: userConfigStorage }));
  app.use('/api/agent', agentRoutes);
  app.use('/api/operator-quotes', operatorQuotesRoutes);
  // 未匹配的 API 路径返回稳定 JSON 404，不回显请求路径与查询串
  app.use('/api', (_req, res) => {
    sendError(res, _req, agentError('AGENT_ROUTE_NOT_FOUND', '接口不存在', { statusCode: 404 }));
  });
  // 统一 API 错误出口：捕获框架错误、业务错误与未知异常
  app.use('/api', apiErrorHandler);
  return app;
}

interface CreateTransportServerOptions {
  app: Express;
  signalingGateway: WebrtcSignalingGateway;
  env?: RuntimeEnvSource;
  readFile?: ReadFileSyncLike;
}

interface LaPlumaTransport {
  server: HttpServer | HttpsServer;
  protocol: 'http' | 'https';
  close(): Promise<void>;
}

function createLaPlumaTransportServer({
  app,
  signalingGateway,
  env = process.env,
  readFile = readFileSync
}: CreateTransportServerOptions): LaPlumaTransport {
  const httpsOptions = loadHttpsOptions(env, readFile);
  const server = httpsOptions
    ? createHttpsServer(httpsOptions, app)
    : createHttpServer(app);
  signalingGateway.attach(server);

  const close = async (): Promise<void> => {
    signalingGateway.close();
    if (!server.listening) return;
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close(error => error ? rejectClose(error) : resolveClose());
    });
  };

  return {
    server,
    protocol: httpsOptions ? 'https' : 'http',
    close
  };
}

export async function startLaPlumaServer({
  env = process.env,
  host = '0.0.0.0',
  port = parsePort(env.PORT, { fallback: 3000, name: 'PORT' }),
  signalingGateway = createWebrtcSignalingGateway(),
  initializeRunStore = initializeAgentRunStore,
  initializeRuntime = initializeRuntimeState,
  logger = console,
  closeDeadlineMs = DEFAULT_CLOSE_DEADLINE_MS,
  executionShutdownOptions = {},
  appPaths = resolveAppPaths({ env })
}: StartLaPlumaServerOptions = {}): Promise<LaPlumaRuntime> {
  // 组装入口集中解析配置并接线运行依赖：应用、传输、Run 存储和运行时恢复共享同一个
  // 生命周期，关闭顺序由注册顺序取反决定，避免各模块在导入时自行启动或停止。
  const lifecycle = createRuntimeLifecycle({ logger, closeDeadlineMs });
  // 就绪投影只读生命周期、初始化阶段与 Run 存储状态；绑定在组装入口完成，
  // 关闭开始后生命周期进入 draining，/readiness 立即转为不可就绪。
  const readiness = createRuntimeReadinessTracker({
    lifecycle,
    runStoreStatus: getAgentRunStoreStatus
  });
  // 预览资源属于本实例的 viewer 会话与本地子进程；先于传输入口注册，
  // 关闭时网关先断开观看连接，再由预览步骤取消计时器并终止本实例子进程。
  const webrtcPreview = attachWebrtcPreviewToLifecycle(lifecycle);
  if (!webrtcPreview.attached) {
    logger.warn?.('[WebRTC] 预览关闭步骤未挂接，关闭时无法保证释放本地预览资源');
  }
  const app = createLaPlumaApp({
    env,
    signalingGateway,
    clientDistPath: appPaths.frontendDistDir,
    readiness
  });
  // 上游默认账号保存在 ScrcpyOverWebRTC 自己的数据目录，服务不能替它改密；
  // 这里只提示迁移，绝不在启动时生成与上游不同步的随机凭据。
  const webrtcCredentials = resolveWebrtcCredentials(env);
  if (webrtcCredentials.usingDefault) {
    logger.warn?.(
      '[WebRTC] 信令网关仍使用上游默认账号；请在上游修改账号后同步设置 '
      + 'LA_PLUMA_WEBRTC_USERNAME 与 LA_PLUMA_WEBRTC_PASSWORD'
    );
  }
  const transport = createLaPlumaTransportServer({ app, signalingGateway, env });
  let listeningPort = port;

  lifecycle.register({
    name: 'agent-run-store',
    start: async () => {
      try {
        const summary = await initializeRunStore();
        logger.log('[AgentRun] 存储已就绪:', {
          filePath: summary.filePath,
          restoredRuns: summary.restoredRuns,
          interruptedRuns: summary.interruptedRuns,
          prunedRuns: summary.prunedRuns
        });
      } catch (error) {
        const status = getAgentRunStoreStatus();
        logger.error('[AgentRun] 存储初始化失败，执行接口已关闭:', {
          filePath: status.filePath,
          error: status.error || readErrorMessage(error)
        });
      }
    }
  });

  lifecycle.register({
    name: 'http-transport',
    start: async () => {
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (error: Error): void => rejectListen(error);
        transport.server.once('error', onError);
        transport.server.listen(port, host, () => {
          transport.server.off('error', onError);
          resolveListen();
        });
      });
      const address = transport.server.address();
      listeningPort = typeof address === 'object' && address ? address.port : port;
    },
    // 传输入口拥有信令网关的挂载与关闭，二者作为同一资源释放。
    close: () => transport.close()
  });

  // 执行关闭在传输入口之后注册、在运行时初始化之前注册：关闭顺序为
  // 运行时初始化注册的触发源/轮询 → 执行收尾与 Run 落盘 → 传输 → 预览。
  // 收尾先于断开连接，仍在等待回复的同步执行可以先按实际结果返回。
  const executionShutdown = attachExecutionShutdownToLifecycle(lifecycle, { logger, ...executionShutdownOptions });
  if (!executionShutdown.attached) {
    logger.warn?.('[Runtime] 执行关闭步骤未挂接，关闭时无法保证停止活动执行与 Run 落盘');
  }

  lifecycle.register({
    name: 'runtime-initialization',
    start: async () => {
      // 初始化阶段单独记录：即使初始化抛错被记录后继续提供 HTTP，就绪端点也保持
      // 不可就绪，直到完成一次完整初始化。
      readiness.markInitializationStarted();
      try {
        // 后台领域通过传入的生命周期端口注册自己的停止能力。
        await initializeRuntime({ lifecycle });
        readiness.markInitializationCompleted();
      } catch (error) {
        readiness.markInitializationFailed();
        logger.error('[Runtime] 初始化失败:', readErrorMessage(error));
      }
    }
  });

  await lifecycle.start();

  const localIp = getLocalIpAddress();
  logger.log('服务器运行在:');
  logger.log(`  - 本地: ${transport.protocol}://localhost:${listeningPort}`);
  logger.log(`  - 网络: ${transport.protocol}://${localIp}:${listeningPort}`);
  logger.log('');
  printPathConfig();

  return {
    app,
    server: transport.server,
    protocol: transport.protocol,
    port: listeningPort,
    lifecycle,
    readiness,
    executionShutdown: executionShutdown.service,
    close: reason => {
      // 关闭请求一到就关闭准入，早于第一个关闭步骤执行：新的执行意图在 Run 准入
      // 与设备租约处都被拒绝；已经开始的执行由执行关闭步骤收尾。
      closeExecutionAdmission(reason || 'shutdown');
      return lifecycle.close(reason);
    }
  };
}

/**
 * 安装 SIGINT/SIGTERM 关闭处理。
 *
 * 重复信号不会启动第二次关闭：同一个关闭 Promise 被复用，后来的信号只记录日志，
 * 不会在收尾中途强行退出；部分步骤失败时其余收尾已由生命周期继续执行，最终以
 * 非零退出码明确报告。`exit`/`logger`/`signals` 可注入以便测试。
 */
export function installShutdownHandlers(runtime: ShutdownRuntime, {
  logger = console,
  exit = code => process.exit(code),
  signals = ['SIGINT', 'SIGTERM']
}: ShutdownHandlerOptions = {}): {
  shutdown(signal: string): Promise<ShutdownOutcome | null>;
  dispose(): void;
} {
  let shutdownPromise: Promise<ShutdownOutcome | null> | null = null;

  const shutdown = (signal: string): Promise<ShutdownOutcome | null> => {
    if (shutdownPromise) {
      logger.warn?.(`[Server] 已收到 ${signal}，关闭流程仍在进行，继续等待`);
      return shutdownPromise;
    }
    shutdownPromise = (async (): Promise<ShutdownOutcome | null> => {
      let summary: ShutdownOutcome | null = null;
      try {
        summary = await runtime.close(signal);
      } catch (error) {
        logger.error?.('[Server] 关闭失败:', readErrorMessage(error));
        exit(1);
        return null;
      }
      const failedSteps = (summary?.steps || []).filter(step => step.status !== 'closed');
      if (summary?.ok === false || failedSteps.length > 0) {
        logger.error?.('[Server] 关闭未完全成功:', failedSteps.length > 0
          ? failedSteps.map(step => `${step.name}:${step.status}`)
          : '未知步骤');
        exit(1);
      } else {
        exit(0);
      }
      return summary;
    })();
    return shutdownPromise;
  };

  const handlers = signals.map(signal => {
    const handler = (): void => { void shutdown(signal); };
    process.on(signal, handler);
    return { signal, handler };
  });

  return {
    shutdown,
    dispose() {
      for (const { signal, handler } of handlers) process.off(signal, handler);
    }
  };
}

const entryArg = process.argv[1];
const isMainModule = entryArg !== undefined && resolve(entryArg) === __filename;
if (isMainModule) {
  try {
    const runtime = await startLaPlumaServer();
    installShutdownHandlers(runtime);
  } catch (error) {
    console.error('[Server] 启动失败:', readErrorMessage(error));
    process.exitCode = 1;
  }
}
