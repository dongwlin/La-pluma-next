/**
 * 执行准入闸门
 *
 * 运行时关闭一旦开始，本实例不再接受新的设备执行。HTTP 执行入口、定时触发、
 * Telegram 指令、维护更新与作业集继续都经过同一个闸门：
 * - 纳入 Run 的入口在 `beginAgentRun` 处拒绝，返回 `AGENT_EXECUTION_SHUTTING_DOWN`；
 * - 直接占用设备租约的入口在 `acquireMaaExecutionLease` 处拒绝，返回
 *   `MAA_EXECUTION_SHUTTING_DOWN`。
 *
 * 闸门只描述本进程。已经开始的执行由关闭流程停止并按实际结果结算；闸门本身不
 * 停止任何资源，也不跨实例协调。每次组装启动安装一个新的闸门，因此进程内重新
 * 组装（测试或进程内重启）不会继承上一份关闭状态。
 */

import { agentError } from '../utils/apiHelper.ts';

export type ExecutionAdmissionErrorCode =
  | 'AGENT_EXECUTION_SHUTTING_DOWN'
  | 'MAA_EXECUTION_SHUTTING_DOWN';

export interface ExecutionAdmissionStatus {
  /** 闸门已关闭：拒绝新的设备执行 */
  closed: boolean;
  /** 关闭原因（信号名或调用方提供的原因） */
  reason: string | null;
  closedAt: string | null;
  /** 本闸门关闭后拒绝的准入次数，仅用于诊断与测试 */
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

/** 安装新闸门；组装入口在挂接执行关闭步骤时调用。缺省创建处于打开状态的新闸门。 */
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
