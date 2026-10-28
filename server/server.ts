/** HTTP/HTTPS 传输与运行时装配；直接执行时先安装关闭信号，再开始异步初始化。 */
import { createServer as createHttpServer } from 'node:http';
import type { RequestListener, Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Server as HttpsServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import { createLaPlumaApp } from './app.ts';
import { printPathConfig } from './config/paths.ts';
import {
  loadHttpsOptions,
  parsePort,
  resolveAppPaths
} from './config/runtimeConfig.ts';
import type { AppPaths, RuntimeEnvSource } from './config/runtimeConfig.ts';
import { resolveWebrtcCredentials } from './config/webrtcCredentials.ts';
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
  RuntimeLifecycleCloseContext,
  RuntimeLifecycleStartContext,
  RuntimeLifecycleCloseSummary,
  RuntimeLifecycleLogger
} from './services/runtimeLifecycleService.ts';
import { createWebrtcSignalingGateway } from './services/webrtcSignalingGateway.ts';
import type { WebrtcSignalingGateway } from './services/webrtcSignalingGateway.ts';
import { attachWebrtcPreviewToLifecycle } from './services/webrtcService.ts';

// 供 isMainModule 判断使用；应用内路径解析已由 config 入口按模块位置锚定
const __filename = fileURLToPath(import.meta.url);

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
  initializeRunStore?: (context: RuntimeLifecycleStartContext) => Promise<AgentRunStoreRestoreSummary>;
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

/** 构造后尚未监听；start 幂等，允许调用方在初始化前安装关闭处理。 */
export interface LaPlumaServer extends LaPlumaRuntime {
  start(): Promise<LaPlumaRuntime>;
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

interface CreateTransportServerOptions {
  app: Express;
  signalingGateway: WebrtcSignalingGateway;
  env?: RuntimeEnvSource;
}

interface LaPlumaTransport {
  server: HttpServer | HttpsServer;
  protocol: 'http' | 'https';
  listen(port: number, host: string, signal: AbortSignal): Promise<void>;
  close(context: RuntimeLifecycleCloseContext): Promise<void>;
}

function createLaPlumaTransportServer({
  app,
  signalingGateway,
  env = process.env
}: CreateTransportServerOptions): LaPlumaTransport {
  const httpsOptions = loadHttpsOptions(env);
  let draining = false;
  const handleRequest: RequestListener = (request, response) => {
    response.once('finish', () => {
      // 关闭开始时仍活动的 keep-alive 连接，在响应完成后也应立即释放。
      if (draining) server.closeIdleConnections();
    });
    app(request, response);
  };
  const server = httpsOptions
    ? createHttpsServer(httpsOptions, handleRequest)
    : createHttpServer(handleRequest);

  const listen = async (port: number, host: string, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    // 网关挂载属于监听步骤，构造和 Run 存储恢复期间不挂载。
    signalingGateway.attach(server);
    signal.throwIfAborted();
    await new Promise<void>((resolveListen, rejectListen) => {
      const listenAbort = new AbortController();
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
        server.off('listening', onListening);
        server.off('error', onError);
      };
      const onAbort = (): void => {
        listenAbort.abort();
        cleanup();
        rejectListen(signal.reason);
      };
      const onError = (error: Error): void => {
        cleanup();
        rejectListen(error);
      };
      const onListening = (): void => {
        // 启动取消只负责未完成的 listen；运行后的 HTTP 由传输关闭阶段排空。
        cleanup();
        resolveListen();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      server.once('error', onError);
      server.once('listening', onListening);
      try {
        server.listen({ port, host, signal: listenAbort.signal });
      } catch (error) {
        cleanup();
        rejectListen(error);
      }
    });
  };

  const close = async ({ signal }: RuntimeLifecycleCloseContext): Promise<void> => {
    draining = true;
    try {
      signalingGateway.close();
    } finally {
      // 网关释放失败也必须停止 HTTP 接受连接；由生命周期记录失败并继续其余收尾。
      if (server.listening) {
        const closed = new Promise<void>((resolveClose, rejectClose) => {
          server.close(error => error ? rejectClose(error) : resolveClose());
        });
        const forceClose = (): void => { server.closeAllConnections(); };
        signal.addEventListener('abort', forceClose, { once: true });
        try {
          // server.close 停止接受新连接并等待在途响应；本步骤预算耗尽才强制断开。
          if (signal.aborted) forceClose();
          await closed;
        } finally {
          signal.removeEventListener('abort', forceClose);
        }
      }
    }
  };

  return {
    server,
    protocol: httpsOptions ? 'https' : 'http',
    listen,
    close
  };
}

export function createLaPlumaServer({
  env = process.env,
  host = '0.0.0.0',
  port = parsePort(env.PORT, { fallback: 3000, name: 'PORT' }),
  signalingGateway = createWebrtcSignalingGateway(),
  initializeRunStore = ({ signal }) => initializeAgentRunStore({ signal }),
  initializeRuntime = initializeRuntimeState,
  logger = console,
  closeDeadlineMs = DEFAULT_CLOSE_DEADLINE_MS,
  executionShutdownOptions = {},
  appPaths = resolveAppPaths({ env })
}: StartLaPlumaServerOptions = {}): LaPlumaServer {
  // 组装入口集中解析配置并接线运行依赖：应用、传输、Run 存储和运行时恢复共享同一个
  // 生命周期，关闭顺序由注册顺序取反决定，避免各模块在导入时自行启动或停止。
  const lifecycle = createRuntimeLifecycle({ logger, closeDeadlineMs });
  // 就绪投影只读生命周期、初始化阶段与 Run 存储状态；绑定在组装入口完成，
  // 关闭开始后生命周期进入 draining，/readiness 立即转为不可就绪。
  const readiness = createRuntimeReadinessTracker({
    lifecycle,
    runStoreStatus: getAgentRunStoreStatus
  });
  const app = createLaPlumaApp({
    env,
    signalingGateway,
    clientDistPath: appPaths.frontendDistDir,
    readiness
  });
  // 先校验 TLS 等同步配置，再把运行时绑定到进程内领域状态。
  const transport = createLaPlumaTransportServer({ app, signalingGateway, env });
  let listeningPort = port;
  let startPromise: Promise<LaPlumaRuntime> | null = null;

  // 注册顺序决定关闭顺序：后台触发源/轮询 → 执行收尾 → 传输 → 预览。
  const webrtcPreview = attachWebrtcPreviewToLifecycle(lifecycle);
  if (!webrtcPreview.attached) {
    logger.warn?.('[WebRTC] 预览关闭步骤未挂接，关闭时无法保证释放本地预览资源');
  }

  lifecycle.register({
    name: 'agent-run-store',
    start: async ({ signal }) => {
      try {
        const summary = await initializeRunStore({ signal });
        signal.throwIfAborted();
        logger.log('[AgentRun] 存储已就绪:', {
          filePath: summary.filePath,
          restoredRuns: summary.restoredRuns,
          interruptedRuns: summary.interruptedRuns,
          prunedRuns: summary.prunedRuns
        });
      } catch (error) {
        signal.throwIfAborted();
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
    start: async ({ signal }) => {
      await transport.listen(port, host, signal);
      const address = transport.server.address();
      listeningPort = typeof address === 'object' && address ? address.port : port;
    },
    // 传输入口拥有信令网关的挂载与关闭，二者作为同一资源释放。
    close: context => transport.close(context)
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
    start: async ({ signal }) => {
      // 初始化阶段单独记录：即使初始化抛错被记录后继续提供 HTTP，就绪端点也保持
      // 不可就绪，直到完成一次完整初始化。
      readiness.markInitializationStarted();
      try {
        // 后台领域通过传入的生命周期端口注册自己的停止能力。
        await initializeRuntime({ lifecycle, signal });
        signal.throwIfAborted();
        readiness.markInitializationCompleted();
      } catch (error) {
        signal.throwIfAborted();
        readiness.markInitializationFailed();
        logger.error('[Runtime] 初始化失败:', readErrorMessage(error));
      }
    }
  });

  const runtime: LaPlumaServer = {
    app,
    server: transport.server,
    protocol: transport.protocol,
    get port() { return listeningPort; },
    lifecycle,
    readiness,
    executionShutdown: executionShutdown.service,
    start() {
      if (startPromise) return startPromise;
      startPromise = (async () => {
        try {
          // 上游账号由 ScrcpyOverWebRTC 管理；这里只提示迁移，不自行改密。
          if (resolveWebrtcCredentials(env).usingDefault) {
            logger.warn?.(
              '[WebRTC] 信令网关仍使用上游默认账号；请在上游修改账号后同步设置 '
              + 'LA_PLUMA_WEBRTC_USERNAME 与 LA_PLUMA_WEBRTC_PASSWORD'
            );
          }
          await lifecycle.start();
          // 初始化期间可能已收到关闭信号，此时不再宣布服务启动完成。
          if (lifecycle.getState() === 'running') {
            logger.log('服务器运行在:');
            logger.log(`  - 本地: ${transport.protocol}://localhost:${listeningPort}`);
            logger.log(`  - 网络: ${transport.protocol}://${getLocalIpAddress()}:${listeningPort}`);
            logger.log('');
            printPathConfig();
          }
          return runtime;
        } catch (error) {
          // 监听等步骤失败时生命周期已回滚；统一关闭入口同时关上执行准入。
          await runtime.close('start-failed');
          throw error;
        }
      })();
      return startPromise;
    },
    close: reason => {
      // 关闭请求一到就关闭准入，早于第一个关闭步骤执行：新的执行意图在 Run 准入
      // 与设备租约处都被拒绝；已经开始的执行由执行关闭步骤收尾。
      closeExecutionAdmission(reason || 'shutdown');
      return lifecycle.close(reason);
    }
  };
  return runtime;
}

/** 常用的一步启动入口；需要提前安装关闭信号时使用 createLaPlumaServer。 */
export async function startLaPlumaServer(options: StartLaPlumaServerOptions = {}): Promise<LaPlumaRuntime> {
  return createLaPlumaServer(options).start();
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
  let shutdownHandlers: ReturnType<typeof installShutdownHandlers> | undefined;
  try {
    const runtime = createLaPlumaServer();
    shutdownHandlers = installShutdownHandlers(runtime);
    await runtime.start();
  } catch (error) {
    shutdownHandlers?.dispose();
    console.error('[Server] 启动失败:', readErrorMessage(error));
    process.exitCode = 1;
  }
}
