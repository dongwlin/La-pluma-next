/**
 * 读取域共享助手 + 掉落/游戏数据载荷
 *
 * 把 Express 的未知输入收窄成读取适配需要的类型：数值 query（`lines`/
 * `days`）按单值读取，原样交给 `resolveBoundedInteger` 统一回落/截断/
 * 夹取。掉落读取的载荷显式建模，掉落服务返回统一 envelope，读取控制器
 * 经 `unwrapReadPayload` 沿用旧实现的 `result.data || result` 真值选择，
 * 不重建成功/失败结构。
 * 状态与日志专属的请求收窄与响应载荷分别建模在 statusDto 与 logDto。
 */

import type {
  ApiErrorResponse,
  ApiRequestLike,
  ApiSuccessResponse
} from '../utils/apiHelper.ts';

/** 读取路由处理器的请求端口：query/body 保持 unknown，由本模块按端点收窄。 */
export interface ReadRequest extends ApiRequestLike {
  body?: unknown;
  query?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 读取单个数值 query 参数（`lines`/`days`）。
 *
 * 重复参数在 Express 中是数组、嵌套语法是对象；这里原样返回该值，由
 * `resolveBoundedInteger` 统一回落/截断/夹取，路由不复制归一规则。
 */
export function readNumericQuery(query: unknown, name: string): unknown {
  return isRecord(query) ? query[name] : undefined;
}

/** 探测失败时只保留 message 文本，不把堆栈带进响应。 */
export function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 读取服务返回的统一 envelope；读取路由不重建成功/失败结构。 */
export type ReadResult<T> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * 掉落读取载荷：成功取 `data`，失败保留错误 envelope。
 * 保留旧实现的 `result.data || result` 真值选择，空值不会被误判成成功。
 */
export type ReadPayload<T> = T | ReadResult<T>;

export function unwrapReadPayload<T>(result: ReadResult<T>): ReadPayload<T> {
  return result.success && result.data ? result.data : result;
}

/** 成功与失败 envelope 都带 message；缺省仍回落“操作成功”。 */
export function readPayloadMessage(result: { message?: string }): string {
  return result.message || '操作成功';
}
