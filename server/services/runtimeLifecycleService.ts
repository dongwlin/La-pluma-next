/**
 * 运行时生命周期协调端口
 *
 * 组装入口按启动顺序注册运行依赖，关闭时按注册的逆序释放，保证“后启动的先停止”。
 * 本模块只协调既有服务，不创建、不重启任何服务，也不替代各领域自己的 stop/close
 * 实现：领域任务把已有的停止能力包装成步骤注册进来即可。
 *
 * 语义：
 * - start：按注册顺序执行启动步骤；某步失败时先逆序回收已开始的步骤，再抛出携带
 *   步骤名的错误。已被受理的启动请求重复调用返回同一结果，不重复执行。
 * - draining：close 一旦被请求即进入 draining；此后拒绝注册新步骤，启动循环不再
 *   开始新步骤。关闭仍会等待进行中的启动步骤结束。
 * - deadline：closeDeadlineMs 是整次关闭的总预算，按剩余步骤均分给每一步，单步至少
 *   1ms。超时的步骤记为 timeout 并继续后续步骤，因此一个卡住的领域不会阻断其余收尾。
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
  start?: () => unknown | Promise<unknown>;
  /** 释放步骤；缺省表示该步骤没有需要释放的资源 */
  close?: () => unknown | Promise<unknown>;
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
  start: (() => unknown | Promise<unknown>) | null;
  close: (() => unknown | Promise<unknown>) | null;
  /** 启动步骤已被受理（无论成功或失败），需要纳入释放范围 */
  active: boolean;
  /** 已执行过释放，重复关闭时跳过 */
  released: boolean;
}

const TIMEOUT = Symbol('runtime-lifecycle-timeout');

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
      // 启动完成后注册的步骤代表已经归属本实例的资源，直接纳入释放范围；
      // 启动期间的步骤由启动循环在轮到它时标记。
      active: state === 'running',
      released: false
    });
  }

  async function closeStep(step: RegisteredStep, timeoutMs: number): Promise<RuntimeLifecycleCloseStepResult> {
    const startedAt = now();
    const close = step.close;
    if (!close) {
      return { name: step.name, status: 'closed', durationMs: 0 };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMEOUT>(resolveTimeout => {
      // 保留 timer 的引用计数：关闭期间即使其他句柄已释放，也应等满预算再退出。
      timer = setTimeout(() => resolveTimeout(TIMEOUT), timeoutMs);
    });
    const work = Promise.resolve()
      .then(() => close())
      .then(
        () => ({ ok: true as const }),
        error => ({ ok: false as const, error })
      );
    const outcome = await Promise.race([work, timeout]);
    if (timer) clearTimeout(timer);
    const durationMs = now() - startedAt;

    if (outcome === TIMEOUT) {
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
   * 逆序释放所有已受理且未释放的步骤。总预算按剩余步骤均分，保证卡住的步骤不会
   * 独占预算；每个步骤至少保留 1ms，从而仍会被尝试。
   */
  async function releaseAll(reason: string): Promise<RuntimeLifecycleCloseSummary> {
    const startedAt = now();
    const deadlineAt = startedAt + deadlineMs;
    const pending = steps.filter(step => step.active && !step.released && step.close).reverse();
    const results: RuntimeLifecycleCloseStepResult[] = [];

    for (let index = 0; index < pending.length; index += 1) {
      const step = pending[index];
      step.released = true;
      const remaining = deadlineAt - now();
      const stepsLeft = pending.length - index;
      const slice = Math.max(1, Math.floor(remaining / stepsLeft));
      results.push(await closeStep(step, slice));
    }

    const failed = results.filter(result => result.status !== 'closed');
    const summary: RuntimeLifecycleCloseSummary = {
      reason,
      state: 'closed',
      ok: failed.length === 0,
      deadlineMs,
      durationMs: now() - startedAt,
      steps: results
    };
    if (failed.length > 0) {
      logger.warn?.('运行时关闭未完全成功', {
        reason,
        failed: failed.map(result => ({ name: result.name, status: result.status }))
      });
    }
    return summary;
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
        if (step.start) await step.start();
      } catch (error) {
        state = 'start-failed';
        const message = describeError(error);
        logger.error?.('运行时启动步骤失败', { step: step.name, error: message });
        await releaseAll('start-rollback');
        throw new RuntimeLifecycleError(
          `运行时启动步骤失败: ${step.name}: ${message}`,
          'RUNTIME_LIFECYCLE_START_FAILED',
          step.name,
          { cause: error }
        );
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
    draining = true;
    if (state !== 'closed') state = 'draining';
    closePromise = (async () => {
      if (startPromise) {
        try {
          await startPromise;
        } catch {
          // 启动失败已完成回滚；这里继续收尾，返回的摘要描述实际释放结果。
        }
      }
      const summary = await releaseAll(reason);
      closeSummary = summary;
      state = 'closed';
      return summary;
    })();
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
