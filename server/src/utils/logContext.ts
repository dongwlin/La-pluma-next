/**
 * 日志关联上下文：把请求、Run 与后台执行的关联字段带入同一条日志。
 *
 * 两级上下文分别存放：
 * - 请求上下文（requestId）：由请求 id 中间件在进入路由前建立；
 * - 执行上下文（runId/operationId）：由执行入口在真正开始执行时建立，
 *   生命周期跟随执行本身而不是 HTTP 请求，因此响应返回后的后台收尾日志
 *   仍能记录同一个 runId/operationId。
 *
 * 执行上下文由 AsyncLocalStorage 沿异步链传递（子进程输出、定时器与
 * 收尾回调都会继承）；没有执行上下文时只输出请求字段，缺失字段不写入日志。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
  requestId?: string;
  runId?: string;
  operationId?: string;
}

const requestStorage = new AsyncLocalStorage<LogContext>();
const executionStorage = new AsyncLocalStorage<LogContext>();

/** 在请求上下文中执行回调；只携带传入字段，未提供的字段不会凭空出现。 */
export function withRequestLogContext<T>(context: LogContext, fn: () => T): T {
  return requestStorage.run({ ...context }, fn);
}

/** 在执行上下文中执行回调；执行结束后上下文随异步链自然释放。 */
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
