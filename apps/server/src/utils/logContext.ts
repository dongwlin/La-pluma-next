import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
  requestId?: string;
  runId?: string;
  operationId?: string;
}

const requestStorage = new AsyncLocalStorage<LogContext>();
const executionStorage = new AsyncLocalStorage<LogContext>();

export function withRequestLogContext<T>(context: LogContext, fn: () => T): T {
  return requestStorage.run({ ...context }, fn);
}

export function withExecutionLogContext<T>(context: LogContext, fn: () => T): T {
  return executionStorage.run({ ...context }, fn);
}

/**
 * 读取当前日志上下文：请求字段在前、执行字段覆盖同名键。
 * 每次返回新对象，调用方可以安全修改；没有上下文时返回空对象。
 */
export function getLogContext(): LogContext {
  const request = requestStorage.getStore();
  const execution = executionStorage.getStore();
  if (!request && !execution) return {};
  return { ...request, ...execution };
}
