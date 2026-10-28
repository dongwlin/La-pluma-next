/**
 * API 令牌鉴权
 *
 * `LA_PLUMA_TOKEN` 是本服务唯一的 API 访问凭据。比较必须：
 * - 只接受字符串请求头，数组/对象等异常类型一律视为未提供；
 * - 先做固定长度摘要，再使用 `timingSafeEqual`，不同长度不会抛错，
 *   也不会在比较时间上泄露预期值的长度；
 * - 失败响应只说明“需要有效令牌”，不回显预期值、变量名或长度；
 * - 认证失败按来源地址限流，有效令牌不参与失败计数，也不被失败计数阻塞。
 *
 * 本模块导入时无副作用，鉴权开关与限流器由组装入口注入。
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { agentError, sendError } from './apiHelper.ts';
import type { LoginThrottle } from './loginThrottle.ts';
import { resolveClientRateLimitKey } from './loginThrottle.ts';

export const AUTH_REQUIRED_CODE = 'AGENT_AUTH_REQUIRED';
export const RATE_LIMITED_CODE = 'AGENT_RATE_LIMITED';

export type ApiAuthHeaders = Record<string, string | string[] | undefined>;

export interface ApiAuthRequestLike {
  headers?: ApiAuthHeaders;
  ip?: unknown;
  socket?: { remoteAddress?: unknown };
}

export interface ApiAuthResponseLike {
  set(field: string, value: string): unknown;
  status(statusCode: number): { json(body: object): unknown };
  json(body: object): unknown;
}

export type ApiAuthNext = (error?: unknown) => void;

/**
 * 固定时间比较：先对两侧做 SHA-256，得到同长摘要后再交给 timingSafeEqual。
 * 类型错误、空预期值或不同长度都返回 false，不抛异常。
 */
export function matchesApiToken(provided: unknown, expected: unknown): boolean {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected === '') return false;
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * 收集请求中可能携带令牌的位置，保持既有语义：
 * `Authorization: Bearer <token>` 与 `X-La-Pluma-Token: <token>`。
 * 非字符串头值（如同一头被多次拼成数组的合成请求）直接忽略。
 */
export function readApiTokenCandidates(headers: ApiAuthHeaders | undefined): string[] {
  const candidates: string[] = [];
  const authorization = headers?.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    candidates.push(authorization.slice('Bearer '.length));
  }
  const headerToken = headers?.['x-la-pluma-token'];
  if (typeof headerToken === 'string') candidates.push(headerToken);
  return candidates;
}

export interface OptionalApiAuthOptions {
  /** 空字符串表示认证关闭；与既有 LA_PLUMA_TOKEN 行为一致 */
  token?: string;
  /** 统计认证失败；有效令牌不会调用它 */
  failureThrottle?: LoginThrottle | null;
}

/**
 * 可选的 API 令牌中间件。认证关闭时直接放行；开启时先校验，再决定是否计入失败限流。
 */
export function createOptionalApiAuth({
  token = '',
  failureThrottle = null
}: OptionalApiAuthOptions = {}): (req: ApiAuthRequestLike, res: ApiAuthResponseLike, next: ApiAuthNext) => void {
  return function optionalApiAuth(req, res, next) {
    if (token === '') return next();

    const candidates = readApiTokenCandidates(req.headers);
    if (candidates.some(candidate => matchesApiToken(candidate, token))) return next();

    if (failureThrottle) {
      const decision = failureThrottle.tryAcquire(resolveClientRateLimitKey(req));
      if (!decision.allowed) {
        res.set('Retry-After', String(decision.retryAfterSeconds));
        return sendError(res, req, agentError(RATE_LIMITED_CODE, '认证失败次数过多，请稍后重试', {
          statusCode: 429,
          retryable: true,
          details: { retryAfterSeconds: decision.retryAfterSeconds }
        }));
      }
    }

    res.set('WWW-Authenticate', 'Bearer realm="la-pluma"');
    return sendError(res, req, agentError(AUTH_REQUIRED_CODE, '需要有效的访问令牌', {
      statusCode: 401,
      retryable: false
    }));
  };
}
