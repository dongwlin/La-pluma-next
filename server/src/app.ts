import { extname, join } from 'node:path';
import cors from 'cors';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { normalizeBasePath, resolveAppPaths } from './config/runtimeConfig.ts';
import type { RuntimeEnvSource } from './config/runtimeConfig.ts';
import { resolveGameAssetPaths } from './config/gameAssetPaths.ts';
import { resolveMaaPaths } from './config/paths.ts';
import operatorQuotesRoutes from './routes/operatorQuotes.ts';
import { createAgentRouter } from './routes/agent.ts';
import { createGameAssetRouter } from './routes/gameAssets.ts';
import { GAME_ASSET_ROUTE_PREFIX } from './services/gameAssetService.ts';
import type { InfrastScheduleService } from './services/infrastScheduleService.ts';
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
import { createLoginThrottle, resolveClientRateLimitKey } from './utils/loginThrottle.ts';
import { requestIdMiddleware } from './utils/requestContext.ts';

/**
 * 进程内限流窗口：认证失败、票据签发与匿名诊断分别计数，均按来源地址隔离；
 * `windowMs` 与 `now` 由三者共用，测试可注入更小阈值与假时钟。
 */
export interface LoginRateLimitOptions {
  windowMs?: number;
  maxAuthFailures?: number;
  maxSignalingLogins?: number;
  maxAnonymousDiagnostics?: number;
  now?: () => number;
}

export interface CreateLaPlumaAppOptions {
  env?: RuntimeEnvSource;
  signalingGateway?: Pick<WebrtcSignalingGateway, 'proxyPath' | 'handleLogin'>;
  clientDistPath?: string;
  userConfigStorage?: UserConfigStorage;
  readiness?: Pick<RuntimeReadinessTracker, 'snapshot'>;
  loginRateLimit?: LoginRateLimitOptions;
  infrastScheduleService?: InfrastScheduleService;
}

// 单实例限流窗口：认证失败与票据签发分别计数，均按来源地址隔离。
// 阈值只防暴力尝试，正常预览一次会话通常只登录一次。
const AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_AUTH_FAILURES_PER_WINDOW = 10;
const MAX_SIGNALING_LOGINS_PER_WINDOW = 30;
// 无 token 的本地/LAN 模式没有鉴权边界，而 /diagnostics 会启动 MAA 版本、ADB 与
// 资源目录等多项外部探测；按来源限流，避免任意页面通过并发请求放大探测开销。
const MAX_ANONYMOUS_DIAGNOSTICS_PER_WINDOW = 30;

export function createLaPlumaApp({
  env = process.env,
  signalingGateway = createWebrtcSignalingGateway(),
  clientDistPath = resolveAppPaths({ env }).frontendDistDir,
  userConfigStorage,
  readiness = createRuntimeReadinessTracker(),
  loginRateLimit = {},
  infrastScheduleService
}: CreateLaPlumaAppOptions = {}): Express {
  if (typeof readiness?.snapshot !== 'function') {
    throw new TypeError('readiness 必须提供 snapshot()');
  }
  const app = express();
  // Express 5 的 req.query 是只读 getter；显式固定 simple 解析器，
  // 让查询参数保持单值扁平结构，不依赖嵌套对象解析。
  app.set('query parser', 'simple');
  const apiToken = env.LA_PLUMA_TOKEN || '';
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
  const anonymousDiagnosticsThrottle = createLoginThrottle({
    windowMs: rateLimitWindowMs,
    maxAttempts: loginRateLimit.maxAnonymousDiagnostics ?? MAX_ANONYMOUS_DIAGNOSTICS_PER_WINDOW,
    now: loginRateLimit.now
  });
  const optionalApiAuth = createOptionalApiAuth({ token: apiToken, failureThrottle: authFailureThrottle });
  const signalingLoginGuard = createSignalingLoginGuard({ token: apiToken, throttle: signalingLoginThrottle });
  const signalingPath = signalingGateway.proxyPath || WEBRTC_SIGNALING_PATH;
  const basePath = normalizeBasePath(env.LA_PLUMA_BASE_PATH);

  // CORS 只声明浏览器可跨域读取响应，不承担鉴权；预检必须在鉴权之前应答，
  // 因此 cors 位于所有路由之前。服务不使用 Cookie，也不支持浏览器凭据模式
  // （credentials: 'include'），跨域调用一律通过 token 头鉴权。
  // 本地图标与头像只服务同源页面：该命名空间不参与 CORS，并声明
  // Cross-Origin-Resource-Policy: same-origin，跨源页面既读不到响应，也无法
  // 通过 <img> 加载结果枚举本机资源目录；同源的 <img> 不受这两个头影响。
  const corsMiddleware = cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  });
  app.use((req: Request, res: Response, next: NextFunction): void => {
    if (req.path === GAME_ASSET_ROUTE_PREFIX || req.path.startsWith(`${GAME_ASSET_ROUTE_PREFIX}/`)) {
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      next();
      return;
    }
    corsMiddleware(req, res, next);
  });

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

  // 图标与头像走同源只读路由，不经过 API 鉴权：<img> 无法附加令牌。
  // 物品图标按物品 id 落盘，兼容 iconId 键；映射所需的 item_table 路径与资源解析一致。
  const gameAssetPaths = resolveGameAssetPaths({ env });
  app.use(
    GAME_ASSET_ROUTE_PREFIX,
    createGameAssetRouter({
      itemDir: gameAssetPaths.itemDir,
      avatarDir: gameAssetPaths.avatarDir,
      itemTablePath: resolveMaaPaths({ env }).itemTablePath
    })
  );

  // API 独占自己的命名空间：鉴权先于 JSON 解析，稳定 404 与错误出口先于静态资源。
  // 探针、信令登录和前端资源不读取业务 JSON 请求体。
  const api = express.Router();
  api.use(optionalApiAuth, express.json());
  // 令牌模式由 optionalApiAuth 承担边界；无令牌模式给诊断入口补一层每来源限流。
  if (apiToken === '') {
    api.use('/agent/diagnostics', (req: Request, res: Response, next: NextFunction): void => {
      const decision = anonymousDiagnosticsThrottle.tryAcquire(resolveClientRateLimitKey(req));
      if (decision.allowed) {
        next();
        return;
      }
      res.set('Retry-After', String(decision.retryAfterSeconds));
      res.set('Cache-Control', 'no-store');
      sendError(res, req, agentError('AGENT_RATE_LIMITED', '诊断请求过于频繁，请稍后重试', {
        statusCode: 429,
        retryable: true,
        details: { retryAfterSeconds: decision.retryAfterSeconds }
      }));
    });
  }
  api.use('/agent/config/user', createUserConfigRouter({ storage: userConfigStorage }));
  api.use('/agent', createAgentRouter({ infrastScheduleService }));
  api.use('/operator-quotes', operatorQuotesRoutes);
  api.use((req, res) => {
    sendError(res, req, agentError('AGENT_ROUTE_NOT_FOUND', '接口不存在', { statusCode: 404 }));
  });
  api.use(apiErrorHandler);
  app.use('/api', api);

  if (env.NODE_ENV === 'production') {
    const staticMountPath = basePath === '/' ? '/' : basePath.slice(0, -1);
    const reservedPaths = ['/api', '/health', '/readiness', GAME_ASSET_ROUTE_PREFIX, signalingPath];
    const frontend = express.Router();
    // 子路径内也保留服务命名空间；文件与 SPA fallback 共用此边界。
    frontend.use((req, _res, next) => {
      if (reservedPaths.some(path => req.path === path || req.path.startsWith(`${path}/`))) {
        return next('router');
      }
      next();
    });
    frontend.use(express.static(clientDistPath));
    frontend.get('/{*splat}', (req: Request, res: Response, next: NextFunction): void => {
      if (extname(req.path)) return next();
      res.sendFile(join(clientDistPath, 'index.html'));
    });
    // static 先处理挂载根到尾斜杠的重定向，再由 fallback 接收根与深链接。
    app.use(staticMountPath, frontend);
  }
  return app;
}
