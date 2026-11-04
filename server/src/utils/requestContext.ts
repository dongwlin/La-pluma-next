/**
 * `x-request-id` 只接受 1–64 位、以字母或数字开头的 `[A-Za-z0-9._:-]` 值；合法值原样沿用，
 * 缺失或非法时生成 UUID 且不回显输入，响应头与 `meta.requestId` 使用同一个值。
 */

import { randomUUID } from 'node:crypto';
import { withRequestLogContext } from './logContext.ts';

export const REQUEST_ID_HEADER = 'x-request-id';
export const REQUEST_ID_MAX_LENGTH = 64;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function normalizeRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > REQUEST_ID_MAX_LENGTH) return null;
  return REQUEST_ID_PATTERN.test(trimmed) ? trimmed : null;
}

export function createRequestId(): string {
  return randomUUID();
}

export function resolveRequestId(value: unknown): string {
  return normalizeRequestId(value) ?? createRequestId();
}

export interface RequestIdRequestLike {
  headers?: Record<string, string | string[] | undefined>;
  id?: unknown;
}

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
