/**
 * 信令票据签发的访问边界
 *
 * 票据入口是浏览器触发上游登录并换取一次性观看凭据的唯一 HTTP 入口。
 * 部署模式不同，实际需要把守的边界也不同：
 *
 * - 受保护远程模式（配置了 `LA_PLUMA_TOKEN`）：令牌已由前置中间件校验，
 *   来源不构成额外边界；本守卫只限制签发频率。
 * - 本地/LAN 模式（未配置令牌）：没有令牌可校验，浏览器跨站页面却可以发起
 *   简单 POST 并用返回的票据建立 WebSocket。此模式只允许同源签发：
 *   无 `Origin` 的非浏览器调用保持可用；`Origin` 必须与 `Host` 一致。
 *   这不是用 CORS 代替鉴权，而是对无凭据模式下唯一能生成设备控制凭据的入口
 *   增加来源约束；`/api` 的既有无令牌行为不变。
 *
 * 频率限制按来源地址独立计数；被拒绝时返回 429 与 `Retry-After`。
 */

import { agentError, sendError } from '../utils/apiHelper.ts';
import { RATE_LIMITED_CODE } from '../utils/apiTokenAuth.ts';
import type { LoginThrottle } from '../utils/loginThrottle.ts';
import { resolveClientRateLimitKey } from '../utils/loginThrottle.ts';

export const SIGNALING_ORIGIN_FORBIDDEN_CODE = 'AGENT_SIGNALING_ORIGIN_FORBIDDEN';

export interface SignalingLoginRequestLike {
  headers?: Record<string, string | string[] | undefined>;
  ip?: unknown;
  socket?: { remoteAddress?: unknown };
}

export interface SignalingLoginResponseLike {
  set(field: string, value: string): unknown;
  status(statusCode: number): { json(body: object): unknown };
  json(body: object): unknown;
}

export type SignalingLoginNext = (error?: unknown) => void;

function headerText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 判断请求是否来自同源页面：
 * - 没有 `Origin`（curl、服务端调用、旧客户端）视为同源可用；
 * - `Origin: null`、非法 URL、缺少或非字符串 `Host` 一律拒绝；
 * - 只比较主机名，不比较协议与端口：本地开发代理会把 `Host` 改写成后端端口，
 *   而协议差异来自反向代理终止 TLS；远端站点的主机名不同，仍会被拒绝。
 */
export function isSameOriginRequest(req: SignalingLoginRequestLike): boolean {
  const origin = req.headers?.origin;
  if (origin === undefined) return true;
  const originText = headerText(origin);
  const hostText = headerText(req.headers?.host);
  if (!originText || !hostText) return false;
  // Host 是 authority，不应携带 userinfo 或路径；拒绝后再交给 URL 解析
  if (hostText.includes('@') || hostText.includes('/') || hostText.includes('\\')) return false;
  try {
    const originHostname = new URL(originText).hostname.toLowerCase();
    const requestHostname = new URL(`http://${hostText}`).hostname.toLowerCase();
    return originHostname !== '' && originHostname === requestHostname;
  } catch {
    return false;
  }
}

export interface SignalingLoginGuardOptions {
  /** 非空表示令牌已由前置中间件把关，本守卫不再比较来源 */
  token?: string;
  throttle: LoginThrottle;
}

export function createSignalingLoginGuard({
  token = '',
  throttle
}: SignalingLoginGuardOptions): (
  req: SignalingLoginRequestLike,
  res: SignalingLoginResponseLike,
  next: SignalingLoginNext
) => void {
  return function signalingLoginGuard(req, res, next) {
    if (token === '' && !isSameOriginRequest(req)) {
      return sendError(res, req, agentError(
        SIGNALING_ORIGIN_FORBIDDEN_CODE,
        '该来源不能签发信令凭据',
        { statusCode: 403, retryable: false }
      ));
    }

    const decision = throttle.tryAcquire(resolveClientRateLimitKey(req));
    if (!decision.allowed) {
      res.set('Retry-After', String(decision.retryAfterSeconds));
      return sendError(res, req, agentError(RATE_LIMITED_CODE, '请求过于频繁，请稍后重试', {
        statusCode: 429,
        retryable: true,
        details: { retryAfterSeconds: decision.retryAfterSeconds }
      }));
    }

    return next();
  };
}
