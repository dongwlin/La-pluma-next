/**
 * 请求 id：校验客户端提供的关联 id，缺失或非法时生成新的 id。
 *
 * 约定（公开契约）：
 * - 请求头 `x-request-id` 可选；合法值为 1–64 位字母、数字与 `.`、`_`、`:`、`-`，
 *   首字符必须是字母或数字；
 * - 合法值原样沿用，响应头 `x-request-id` 与响应 `meta.requestId` 使用同一个值；
 * - 缺失、超长或含其他字符时丢弃客户端值并生成 UUID，不回显非法输入；
 * - 日志上下文在同一中间件内建立，因此同一请求的日志与响应 meta 可互相核对。
 */

import { randomUUID } from 'node:crypto';
import { withRequestLogContext } from './logContext.ts';

export const REQUEST_ID_HEADER = 'x-request-id';
export const REQUEST_ID_MAX_LENGTH = 64;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** 校验并归一请求 id：仅接受限定长度的安全字符，其余一律视为缺失。 */
export function normalizeRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > REQUEST_ID_MAX_LENGTH) return null;
  return REQUEST_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/** 生成服务端请求 id（UUID v4）。 */
export function createRequestId(): string {
  return randomUUID();
}

/** 解析请求 id：合法值沿用，否则生成新的 id。 */
export function resolveRequestId(value: unknown): string {
  return normalizeRequestId(value) ?? createRequestId();
}

/** 请求 id 中间件读取的最小请求结构。 */
export interface RequestIdRequestLike {
  headers?: Record<string, string | string[] | undefined>;
  id?: unknown;
}

/** 请求 id 中间件需要的最小响应结构（只设置响应头）。 */
export interface RequestIdResponseLike {
  setHeader?(name: string, value: string): unknown;
}

export type RequestIdNext = () => void;

/**
 * Express 请求 id 中间件：写入 `req.id` 与响应头，并在请求日志上下文中继续处理。
 * 放在鉴权与请求体解析之前，401/400 等前置失败也能带同一个 id。
 */
export function requestIdMiddleware(
  req: RequestIdRequestLike,
  res: RequestIdResponseLike,
  next: RequestIdNext
): void {
  const requestId = resolveRequestId(req.headers?.[REQUEST_ID_HEADER]);
  req.id = requestId;
  res.setHeader?.(REQUEST_ID_HEADER, requestId);
  withRequestLogContext({ requestId }, next);
}
