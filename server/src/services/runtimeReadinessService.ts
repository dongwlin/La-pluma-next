/**
 * `/health` 只表达进程存活；`/readiness` 只由进程内状态判定（生命周期 `running`、
 * 初始化完成、Run 存储可用），失败一律保持不就绪。不探测设备或外部依赖，设备离线
 * 不得触发容器重启；快照不返回存储路径、凭据或底层错误文本。
 */

import type { RuntimeLifecycleState } from './runtimeLifecycleService.ts';

/** `unattached` 表示应用未接入运行时生命周期（独立挂载应用或测试装配）。 */
export type ReadinessLifecycleState = RuntimeLifecycleState | 'unattached';

export type ReadinessInitializationState = 'pending' | 'running' | 'completed' | 'failed';

/** `not_required` 表示当前没有要求 Run 存储（例如未接入运行时初始化的独立应用）。 */
export type ReadinessRunStoreState = 'not_required' | 'ready' | 'unavailable';

export interface ReadinessCheck<TState extends string> {
  ok: boolean;
  state: TState;
}

export interface ReadinessSnapshot {
  ready: boolean;
  status: 'ready' | 'not_ready';
  checks: {
    lifecycle: ReadinessCheck<ReadinessLifecycleState>;
    initialization: ReadinessCheck<ReadinessInitializationState>;
    runStore: ReadinessCheck<ReadinessRunStoreState>;
  };
  /** 稳定原因码，供编排与日志判断；不含路径、凭据或底层错误文本 */
  reasons: string[];
}

/** 只读取生命周期状态的端口，避免服务直接依赖完整生命周期实现。 */
export interface ReadinessLifecyclePort {
  getState(): RuntimeLifecycleState;
}

export interface AgentRunStoreReadinessStatus {
  required?: boolean;
  ready?: boolean;
}

export interface RuntimeReadinessOptions {
  lifecycle?: ReadinessLifecyclePort | null;
  runStoreStatus?: (() => AgentRunStoreReadinessStatus | null) | null;
}

export interface RuntimeReadinessTracker {
  markInitializationStarted(): void;
  markInitializationCompleted(): void;
  /** 运行时初始化步骤抛出错误；只记录阶段，不保存错误文本 */
  markInitializationFailed(): void;
  snapshot(): ReadinessSnapshot;
}

function lifecycleReason(state: ReadinessLifecycleState): string {
  switch (state) {
    case 'unattached':
      return 'runtime_not_attached';
    case 'idle':
    case 'starting':
      return 'lifecycle_starting';
    case 'draining':
      return 'draining';
    case 'closed':
      return 'lifecycle_closed';
    case 'start-failed':
      return 'lifecycle_start_failed';
    case 'running':
      return 'lifecycle_running';
  }
}

function readLifecycle(
  lifecycle: ReadinessLifecyclePort | null
): ReadinessCheck<ReadinessLifecycleState> {
  if (!lifecycle) return { ok: false, state: 'unattached' };
  try {
    const state = lifecycle.getState();
    return { ok: state === 'running', state };
  } catch {
    // 读取失败按未接入处理：宁可拒绝就绪，也不声称可服务。
    return { ok: false, state: 'unattached' };
  }
}

function readRunStore(
  provider: (() => AgentRunStoreReadinessStatus | null) | null
): ReadinessCheck<ReadinessRunStoreState> {
  if (!provider) return { ok: true, state: 'not_required' };
  let status: AgentRunStoreReadinessStatus | null;
  try {
    status = provider();
  } catch {
    return { ok: false, state: 'unavailable' };
  }
  // 存储尚未被要求初始化（独立挂载应用）时不阻塞；一旦初始化被要求，
  // `required && !ready` 覆盖初始化失败与后续写入失败。
  if (!status?.required) return { ok: true, state: 'not_required' };
  return status.ready === true
    ? { ok: true, state: 'ready' }
    : { ok: false, state: 'unavailable' };
}

export function createRuntimeReadinessTracker(
  options: RuntimeReadinessOptions = {}
): RuntimeReadinessTracker {
  const lifecycle = options.lifecycle ?? null;
  const runStoreStatus = options.runStoreStatus ?? null;
  let initialization: ReadinessInitializationState = 'pending';

  function snapshot(): ReadinessSnapshot {
    const lifecycleCheck = readLifecycle(lifecycle);
    const initializationCheck: ReadinessCheck<ReadinessInitializationState> = {
      ok: initialization === 'completed',
      state: initialization
    };
    const runStoreCheck = readRunStore(runStoreStatus);

    const reasons: string[] = [];
    if (!lifecycleCheck.ok) reasons.push(lifecycleReason(lifecycleCheck.state));
    if (!initializationCheck.ok) {
      if (initialization === 'failed') reasons.push('initialization_failed');
      else if (initialization === 'running') reasons.push('initialization_in_progress');
      else reasons.push('initialization_pending');
    }
    if (!runStoreCheck.ok) reasons.push('run_store_unavailable');

    const ready = reasons.length === 0;
    return {
      ready,
      status: ready ? 'ready' : 'not_ready',
      checks: {
        lifecycle: lifecycleCheck,
        initialization: initializationCheck,
        runStore: runStoreCheck
      },
      reasons
    };
  }

  return {
    markInitializationStarted() {
      initialization = 'running';
    },
    markInitializationCompleted() {
      initialization = 'completed';
    },
    markInitializationFailed() {
      initialization = 'failed';
    },
    snapshot
  };
}
