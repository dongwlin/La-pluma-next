/**
 * Express 应用装配：CORS、请求 id、认证与限流、信令登录入口、生产静态资源
 * 与 API 路由挂载都集中在这里。HTTP/HTTPS 传输与启动初始化见 server.ts；
 * 测试通过 createLaPlumaApp 注入 env、信令网关与 readiness，无需监听端口。
 */
import { extname, join } from 'node:path';
import cors from 'cors';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { normalizeBasePath, resolveAppPaths } from './config/runtimeConfig.ts';
import type { RuntimeEnvSource } from './config/runtimeConfig.ts';
import operatorQuotesRoutes from './routes/operatorQuotes.ts';
import agentRoutes from './routes/agent.ts';
import { createUserConfigRouter } from './routes/userConfig.ts';
import { createRuntimeReadinessTracker } from './services/runtimeReadinessService.ts';
import type { RuntimeReadinessTracker } from './services/runtimeReadinessService.ts';
import { createSignalingLoginGuard } from './services/signalingLoginGuard.ts';
import {
  createWebrtcSignalingGateway,
  WEBRTC_SIGNALING_PATH
} from './services/webrtcSignalingGateway.ts';
import type { WebrtcSignalingGateway } from './services/webrtcSignalingGateway.ts';
import type { UserConfigStorage } from './services/configStorageService.ts';
import { agentError, apiErrorHandler, sendError } from './utils/apiHelper.ts';
import { createOptionalApiAuth } from './utils/apiTokenAuth.ts';
import { createLoginThrottle } from './utils/loginThrottle.ts';
import { requestIdMiddleware } from './utils/requestContext.ts';

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
