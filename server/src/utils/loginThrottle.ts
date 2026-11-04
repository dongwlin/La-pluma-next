/**
 * 进程内固定窗口限流，条目数有上限并在插入时清理过期窗口；仅供单实例防暴力破解，
 * 不承担多实例共享限流，也不写盘。
 */

/** 触发本次判断的来源键；只用于内存计数，不写入日志或响应。 */
export interface ClientAddressRequestLike {
  ip?: unknown;
  socket?: { remoteAddress?: unknown };
}

export interface LoginThrottleOptions {
  windowMs?: number;
  maxAttempts?: number;
  maxEntries?: number;
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
  reset(key?: string): void;
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
