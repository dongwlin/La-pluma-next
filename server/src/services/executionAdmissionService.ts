import { agentError } from '../utils/apiHelper.ts';

export type ExecutionAdmissionErrorCode =
  | 'AGENT_EXECUTION_SHUTTING_DOWN'
  | 'MAA_EXECUTION_SHUTTING_DOWN';

export interface ExecutionAdmissionStatus {
  closed: boolean;
  reason: string | null;
  closedAt: string | null;
  rejected: number;
}

export interface ExecutionAdmissionGate {
  close(reason?: string): ExecutionAdmissionStatus;
  isClosed(): boolean;
  status(): ExecutionAdmissionStatus;
  assertOpen(code: ExecutionAdmissionErrorCode, message: string): void;
}

export function createExecutionAdmissionGate(): ExecutionAdmissionGate {
  let closed = false;
  let reason: string | null = null;
  let closedAt: string | null = null;
  let rejected = 0;

  function status(): ExecutionAdmissionStatus {
    return { closed, reason, closedAt, rejected };
  }

  function close(nextReason = 'shutdown'): ExecutionAdmissionStatus {
    if (!closed) {
      closed = true;
      reason = nextReason || 'shutdown';
      closedAt = new Date().toISOString();
    }
    return status();
  }

  function assertOpen(code: ExecutionAdmissionErrorCode, message: string): void {
    if (!closed) return;
    rejected += 1;
    throw agentError(code, message, {
      statusCode: 503,
      details: { reason },
      retryable: true
    });
  }

  return {
    close,
    isClosed: () => closed,
    status,
    assertOpen
  };
}

let activeGate: ExecutionAdmissionGate | null = null;

export function installExecutionAdmissionGate(
  gate: ExecutionAdmissionGate = createExecutionAdmissionGate()
): ExecutionAdmissionGate {
  activeGate = gate;
  return gate;
}

export function getExecutionAdmissionGate(): ExecutionAdmissionGate | null {
  return activeGate;
}

export function assertExecutionAdmissionOpen(
  code: ExecutionAdmissionErrorCode,
  message: string
): void {
  activeGate?.assertOpen(code, message);
}

/**
 * 关闭当前闸门。组装入口在收到信号时先调用本函数，使准入在第一个关闭步骤执行前
 * 就已拒绝新执行；没有安装闸门（未组装运行时）时返回 null，不创建新状态。
 */
export function closeExecutionAdmission(reason = 'shutdown'): ExecutionAdmissionStatus | null {
  return activeGate ? activeGate.close(reason) : null;
}

/** 仅测试使用：清除闸门，使同一进程内的下一个测试从放行状态开始。 */
export function clearExecutionAdmissionGateForTests(): void {
  activeGate = null;
}
