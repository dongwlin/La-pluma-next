/**
 * 登录/认证失败限流
 *
 * 固定窗口、按来源键计数，用于保护只有少量入口的凭据交换路径：
 * - 信令票据签发（每次签发都会登录一次上游）；
 * - API 令牌认证失败（只统计失败，不阻止有效令牌）。
 *
 * 计数只保存在当前进程内，不写入磁盘；键按来源地址归一，条目数量有上限，
 * 过期窗口在插入时清理，避免攻击者用大量来源地址撑大内存。
 * 这是单实例的防暴力破解措施，不承担多实例共享限流的职责。
 */

/** 触发本次判断的来源键；只用于内存计数，不写入日志或响应。 */
export interface ClientAddressRequestLike {
  ip?: unknown;
  socket?: { remoteAddress?: unknown };
}

export interface LoginThrottleOptions {
  /** 统计窗口长度，毫秒 */
  windowMs?: number;
  /** 单个来源在窗口内允许的次数 */
  maxAttempts?: number;
  /** 内存中最多保留的来源条目数 */
  maxEntries?: number;
  /** 可注入的时钟，便于测试窗口推进 */
  now?: () => number;
}

export interface LoginThrottleDecision {
  allowed: boolean;
  /** 被拒绝时建议的等待秒数；允许时为 0 */
  retryAfterSeconds: number;
}

export interface LoginThrottle {
  /** 记录一次尝试并给出判断；被拒绝时不会延长当前窗口 */
  tryAcquire(key: string): LoginThrottleDecision;
  /** 清除指定来源或全部计数 */
  reset(key?: string): void;
  /** 当前保留的来源条目数，供边界测试使用 */
  size(): number;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 30;
const DEFAULT_MAX_ENTRIES = 1_024;

interface WindowEntry {
  windowStart: number;
  attempts: number;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * 从请求读取限流键：优先 Express 归一后的 `req.ip`，否则使用套接字地址。
 * 未启用 trust proxy，`req.ip` 来自实际连接，不接受调用方伪造的转发头。
 */
export function resolveClientRateLimitKey(req: ClientAddressRequestLike): string {
  if (typeof req.ip === 'string' && req.ip !== '') return req.ip;
  const remoteAddress = req.socket?.remoteAddress;
  return typeof remoteAddress === 'string' && remoteAddress !== '' ? remoteAddress : 'unknown';
}

export function createLoginThrottle(options: LoginThrottleOptions = {}): LoginThrottle {
  const windowMs = positiveInteger(options.windowMs, DEFAULT_WINDOW_MS);
  const maxAttempts = positiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const now = options.now ?? Date.now;
  const entries = new Map<string, WindowEntry>();

  function evictExpired(currentTime: number): void {
    for (const [key, entry] of entries) {
      if (entry.windowStart + windowMs <= currentTime) entries.delete(key);
    }
  }

  function evictOldestUntilBelowLimit(): void {
    while (entries.size >= maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) return;
      entries.delete(oldestKey);
    }
  }

  return {
    tryAcquire(key) {
      const currentTime = now();
      const existing = entries.get(key);
      if (!existing || existing.windowStart + windowMs <= currentTime) {
        if (!existing && entries.size >= maxEntries) {
          evictExpired(currentTime);
          evictOldestUntilBelowLimit();
        }
        entries.set(key, { windowStart: currentTime, attempts: 1 });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (existing.attempts < maxAttempts) {
        existing.attempts += 1;
        return { allowed: true, retryAfterSeconds: 0 };
      }
      const remainingMs = existing.windowStart + windowMs - currentTime;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000))
      };
    },
    reset(key) {
      if (key === undefined) entries.clear();
      else entries.delete(key);
    },
    size() {
      return entries.size;
    }
  };
}
