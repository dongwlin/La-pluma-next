/**
 * 运行时生命周期协调端口
 *
 * 组装入口按启动顺序注册运行依赖，关闭时按注册的逆序释放，保证“后启动的先停止”。
 * 本模块只协调既有服务，不创建、不重启任何服务，也不替代各领域自己的 stop/close
 * 实现：领域任务把已有的停止能力包装成步骤注册进来即可。
 *
 * 语义：
 * - start：按注册顺序执行启动步骤；某步失败时先逆序回收已受理或已获资源的步骤，再抛出携带
 *   步骤名的错误。已被受理的启动请求重复调用返回同一结果，不重复执行。
 * - draining：close 一旦被请求即进入 draining；此后拒绝注册新步骤，启动循环不再
 *   开始新步骤，并通过 signal 取消初始化。
 * - deadline：从收到 close 起统一计算预算，等待初始化退出与逆序释放共用截止时间。
 *   启动不响应取消时记录 timeout，继续收尾；关闭步骤超时也会取消其 signal。
 * - 重复 close：第一次关闭的 Promise 被复用；重复调用不重复执行任何 close，返回同一
 *   关闭摘要。单步失败只记录结果，不抛出，避免吞掉仍可执行的后续清理。
 */

export type RuntimeLifecycleState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'draining'
  | 'closed'
  | 'start-failed';

export interface RuntimeLifecycleLogger {
  info?(message: string, data?: unknown): unknown;
  warn?(message: string, data?: unknown): unknown;
  error?(message: string, data?: unknown): unknown;
}

export interface RuntimeLifecycleStep {
  /** 唯一名称：用于日志、重复注册拒绝和测试断言 */
  name: string;
  /** 启动步骤；缺省表示资源在注册前已由组装入口启动 */
  start?: (context: RuntimeLifecycleStartContext) => unknown | Promise<unknown>;
  /**
   * 释放步骤；缺省表示该步骤没有需要释放的资源。
   * 入参给出本步骤分到的预算与关闭原因，长耗时收尾可据此在超时前自行收束。
   */
  close?: (context: RuntimeLifecycleCloseContext) => unknown | Promise<unknown>;
}

export interface RuntimeLifecycleStartContext {
  signal: AbortSignal;
}

export interface RuntimeLifecycleCloseContext {
  /** 触发本次关闭的原因（信号名或调用方提供） */
  reason: string;
  /** 本步骤分到的时间预算；等于超时监控使用的时长 */
  timeoutMs: number;
  /** 整次关闭的绝对截止时间，与初始化等待共用预算。 */
  deadlineAt: number;
  /** 本步骤份额耗尽时取消，供传输等资源执行强制收尾。 */
  signal: AbortSignal;
}

export interface RuntimeLifecycleStartSummary {
  /** 按执行顺序记录成功的步骤名 */
  started: string[];
  durationMs: number;
}

export type RuntimeLifecycleCloseStepStatus = 'closed' | 'failed' | 'timeout';

export interface RuntimeLifecycleCloseStepResult {
  name: string;
  status: RuntimeLifecycleCloseStepStatus;
  durationMs: number;
  /** 仅在 failed 时提供，保留 release 抛出的错误信息 */
  error?: string;
}

export interface RuntimeLifecycleCloseSummary {
  reason: string;
  state: 'closed';
  /** 全部步骤是否都成功释放；timeout 与 failed 均记为 false */
  ok: boolean;
  deadlineMs: number;
  durationMs: number;
  steps: RuntimeLifecycleCloseStepResult[];
}

export interface RuntimeLifecycleOptions {
  logger?: RuntimeLifecycleLogger;
  /** 整次关闭的总预算，默认 10s */
  closeDeadlineMs?: number;
  /** 时钟注入点，测试可用假时钟；默认 Date.now */
  now?: () => number;
}

export interface RuntimeLifecycle {
  register(step: RuntimeLifecycleStep): void;
  start(): Promise<RuntimeLifecycleStartSummary>;
  close(reason?: string): Promise<RuntimeLifecycleCloseSummary>;
  isDraining(): boolean;
  getState(): RuntimeLifecycleState;
  getCloseSummary(): RuntimeLifecycleCloseSummary | null;
}

export const DEFAULT_CLOSE_DEADLINE_MS = 10_000;

export class RuntimeLifecycleError extends Error {
  code: string;
  stepName: string | null;

  constructor(message: string, code: string, stepName: string | null = null, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuntimeLifecycleError';
    this.code = code;
    this.stepName = stepName;
  }
}

interface RegisteredStep {
  name: string;
  start: ((context: RuntimeLifecycleStartContext) => unknown | Promise<unknown>) | null;
  close: ((context: RuntimeLifecycleCloseContext) => unknown | Promise<unknown>) | null;
  /** 已受理启动（无论成功或失败）或已登记既有资源，需要纳入释放范围 */
  active: boolean;
  /** 已执行过释放，重复关闭时跳过 */
  released: boolean;
}

const TIMEOUT = Symbol('runtime-lifecycle-timeout');

interface ShutdownWindow {
  reason: string;
  startedAt: number;
  deadlineAt: number;
}

async function withinBudget<T>(work: Promise<T>, timeoutMs: number): Promise<T | typeof TIMEOUT> {
  if (timeoutMs <= 0) return TIMEOUT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<typeof TIMEOUT>(resolve => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertDeadline(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RuntimeLifecycleError(
      `closeDeadlineMs 必须是正数，收到: ${JSON.stringify(value)}`,
      'RUNTIME_LIFECYCLE_INVALID'
    );
  }
  return value;
}

export function createRuntimeLifecycle({
  logger = console,
  closeDeadlineMs = DEFAULT_CLOSE_DEADLINE_MS,
  now = () => Date.now()
}: RuntimeLifecycleOptions = {}): RuntimeLifecycle {
  const deadlineMs = assertDeadline(closeDeadlineMs);
  const steps: RegisteredStep[] = [];
  const names = new Set<string>();
  let state: RuntimeLifecycleState = 'idle';
  let draining = false;
  let startPromise: Promise<RuntimeLifecycleStartSummary> | null = null;
  let closePromise: Promise<RuntimeLifecycleCloseSummary> | null = null;
  let closeSummary: RuntimeLifecycleCloseSummary | null = null;
  const startupAbort = new AbortController();
  const abandonStartup = Promise.withResolvers<typeof TIMEOUT>();
  let startingStep: RegisteredStep | null = null;
  let startupProblem: RuntimeLifecycleCloseStepResult | null = null;
  let shutdownWindow: ShutdownWindow | null = null;
  let releasePromise: Promise<RuntimeLifecycleCloseSummary> | null = null;

  function getShutdownWindow(reason: string): ShutdownWindow {
    if (!shutdownWindow) {
      const startedAt = now();
      shutdownWindow = { reason, startedAt, deadlineAt: startedAt + deadlineMs };
    }
    return shutdownWindow;
  }

  function register(step: RuntimeLifecycleStep): void {
    if (!step || typeof step.name !== 'string' || step.name.trim() === '') {
      throw new RuntimeLifecycleError(
        '生命周期步骤必须包含非空 name',
        'RUNTIME_LIFECYCLE_INVALID'
      );
    }
    if (names.has(step.name)) {
      throw new RuntimeLifecycleError(
        `生命周期步骤重复注册: ${step.name}`,
        'RUNTIME_LIFECYCLE_DUPLICATE',
        step.name
      );
    }
    if (step.start !== undefined && typeof step.start !== 'function') {
      throw new RuntimeLifecycleError(
        `生命周期步骤 ${step.name} 的 start 必须是函数`,
        'RUNTIME_LIFECYCLE_INVALID',
        step.name
      );
    }
    if (step.close !== undefined && typeof step.close !== 'function') {
      throw new RuntimeLifecycleError(
        `生命周期步骤 ${step.name} 的 close 必须是函数`,
        'RUNTIME_LIFECYCLE_INVALID',
        step.name
      );
    }
    if (draining || state === 'closed' || state === 'start-failed') {
      throw new RuntimeLifecycleError(
        `生命周期当前状态 ${state} 不允许注册步骤: ${step.name}`,
        'RUNTIME_LIFECYCLE_CLOSED',
        step.name
      );
    }
    if (state === 'running' && step.start !== undefined) {
      throw new RuntimeLifecycleError(
        `生命周期已启动完成，不能再注册带 start 的步骤: ${step.name}`,
        'RUNTIME_LIFECYCLE_INVALID',
        step.name
      );
    }
    names.add(step.name);
    steps.push({
      name: step.name,
      start: step.start ?? null,
      close: step.close ?? null,
      // 只有 close 的步骤代表已经获得的资源，注册即纳入释放；否则初始化中途
      // 收到关闭或抛错时，启动循环尚未遍历到的领域停止能力会被遗漏。
      // 带 start 的步骤仍在启动循环实际受理时才纳入回收。
      active: step.start === undefined,
      released: false
    });
  }

  async function closeStep(
    step: RegisteredStep,
    timeoutMs: number,
    window: ShutdownWindow
  ): Promise<RuntimeLifecycleCloseStepResult> {
    const startedAt = now();
    const close = step.close;
    if (!close) {
      return { name: step.name, status: 'closed', durationMs: 0 };
    }
    const abort = new AbortController();
    const cancel = (): void => { abort.abort(new DOMException('运行时关闭步骤超时', 'TimeoutError')); };
    if (timeoutMs <= 0) cancel();
    const work = Promise.resolve().then(() => close({
      reason: window.reason, timeoutMs, deadlineAt: window.deadlineAt, signal: abort.signal
    }))
      .then(
        () => ({ ok: true as const }),
        error => ({ ok: false as const, error })
      );
    const outcome = await withinBudget(work, timeoutMs);
    const durationMs = now() - startedAt;

    if (outcome === TIMEOUT) {
      cancel();
      logger.warn?.('运行时关闭步骤超时', { step: step.name, timeoutMs, durationMs });
      return { name: step.name, status: 'timeout', durationMs };
    }
    if (!outcome.ok) {
      const message = describeError(outcome.error);
      logger.error?.('运行时关闭步骤失败', { step: step.name, error: message, durationMs });
      return { name: step.name, status: 'failed', durationMs, error: message };
    }
    return { name: step.name, status: 'closed', durationMs };
  }

  /**
   * 逆序释放已获资源。每步按剩余预算均分；预算已耗尽时仍调用释放端口，
   * 传入已取消的 signal 和零预算，不为后续步骤重新计时。
   */
  async function releaseAll(window: ShutdownWindow): Promise<RuntimeLifecycleCloseSummary> {
    const pending = steps.filter(step => step.active && !step.released && step.close).reverse();
    const results: RuntimeLifecycleCloseStepResult[] = startupProblem ? [startupProblem] : [];

    for (let index = 0; index < pending.length; index += 1) {
      const step = pending[index];
      step.released = true;
      const remaining = Math.max(0, window.deadlineAt - now());
      const stepsLeft = pending.length - index;
      const slice = Math.floor(remaining / stepsLeft);
      results.push(await closeStep(step, slice, window));
    }

    const failed = results.filter(result => result.status !== 'closed');
    const summary: RuntimeLifecycleCloseSummary = {
      reason: window.reason,
      state: 'closed',
      ok: failed.length === 0,
      deadlineMs,
      durationMs: now() - window.startedAt,
      steps: results
    };
    if (failed.length > 0) {
      logger.warn?.('运行时关闭未完全成功', {
        reason: window.reason,
        failed: failed.map(result => ({ name: result.name, status: result.status }))
      });
    }
    return summary;
  }

  function releaseOnce(window: ShutdownWindow): Promise<RuntimeLifecycleCloseSummary> {
    releasePromise ??= Promise.resolve().then(() => releaseAll(window));
    return releasePromise;
  }

  async function runStart(): Promise<RuntimeLifecycleStartSummary> {
    const startedAt = now();
    const started: string[] = [];
    let index = 0;
    // 步骤在启动期间仍可追加（例如运行时恢复阶段注册领域停止能力），因此按索引遍历。
    while (index < steps.length) {
      if (draining) break;
      const step = steps[index];
      // 先标记为已受理：启动失败的步骤也可能已部分占用资源，需要它自己的 close 回收。
      step.active = true;
      try {
        if (step.start) {
          startingStep = step;
          const work = Promise.resolve().then(() => {
            startupAbort.signal.throwIfAborted();
            return step.start?.({ signal: startupAbort.signal });
          }).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
          const outcome = await Promise.race([work, abandonStartup.promise]);
          if (outcome === TIMEOUT) break;
          startingStep = null;
          if (!outcome.ok) throw outcome.error;
        }
      } catch (error) {
        startingStep = null;
        if (draining) {
          if (error !== startupAbort.signal.reason && !(error instanceof Error && error.name === 'AbortError')) {
            startupProblem = { name: `${step.name}:start`, status: 'failed', durationMs: now() - startedAt, error: describeError(error) };
          }
          break;
        }
        state = 'start-failed';
        draining = true;
        const message = describeError(error);
        logger.error?.('运行时启动步骤失败', { step: step.name, error: message });
        const failure = new RuntimeLifecycleError(
          `运行时启动步骤失败: ${step.name}: ${message}`,
          'RUNTIME_LIFECYCLE_START_FAILED',
          step.name,
          { cause: error }
        );
        const window = getShutdownWindow('start-rollback');
        startupAbort.abort(failure);
        closeSummary = await releaseOnce(window);
        throw failure;
      }
      started.push(step.name);
      index += 1;
    }
    if (!draining && state === 'starting') state = 'running';
    return { started, durationMs: now() - startedAt };
  }

  function start(): Promise<RuntimeLifecycleStartSummary> {
    if (startPromise) return startPromise;
    if (draining || state === 'closed') {
      return Promise.reject(new RuntimeLifecycleError(
        '生命周期已进入关闭流程，不能启动',
        'RUNTIME_LIFECYCLE_CLOSED'
      ));
    }
    state = 'starting';
    startPromise = runStart();
    return startPromise;
  }

  function close(reason = 'shutdown'): Promise<RuntimeLifecycleCloseSummary> {
    if (closePromise) return closePromise;
    const pending = Promise.withResolvers<RuntimeLifecycleCloseSummary>();
    closePromise = pending.promise;
    const window = getShutdownWindow(reason);
    draining = true;
    if (state !== 'closed') state = 'draining';
    startupAbort.abort(new DOMException('运行时正在关闭', 'AbortError'));
    void (async () => {
      if (startPromise && startingStep && !releasePromise) {
        // 给初始化一次停止份额，保留其余预算用于资源释放。
        const releaseCount = steps.filter(step => step.active && !step.released && step.close).length;
        const slice = Math.floor(Math.max(0, window.deadlineAt - now()) / (releaseCount + 1));
        const outcome = await withinBudget(startPromise.catch(() => undefined), slice);
        if (outcome === TIMEOUT) {
          startupProblem = { name: `${startingStep?.name ?? 'runtime'}:start`, status: 'timeout', durationMs: now() - window.startedAt };
          abandonStartup.resolve(TIMEOUT);
        }
      }
      const summary = await releaseOnce(window);
      closeSummary = summary;
      state = 'closed';
      return summary;
    })().then(pending.resolve, pending.reject);
    return closePromise;
  }

  return {
    register,
    start,
    close,
    isDraining: () => draining,
    getState: () => state,
    getCloseSummary: () => closeSummary
  };
}
