/**
 * 日志脱敏工具：对结构化数据与文本中的凭据类字段做统一替换。
 *
 * 规则：
 * - 字段名命中凭据集合（授权头、cookie、token、密码、密钥、信令 ticket 等）时，
 *   值整体替换为 [REDACTED]，不保留长度或前缀；
 * - 文本中的 `key=value`、`"key": "value"`、`Authorization: Bearer ...` 与裸
 *   `Bearer/Basic <凭据>` 同样替换，只保留字段名；
 * - 只处理日志视图，不修改调用方对象；循环引用与过深层级以占位符截断。
 *
 * 该工具只负责“不原样输出”，不判断业务字段是否真的敏感：字段名匹配即替换，
 * 宁可少记录也不把凭据写进日志。
 */

export const REDACTED = '[REDACTED]';

/** 凭据类字段名：大小写不敏感，匹配字段名任意位置（botToken、apiKey、clientSecret 等）。 */
const SENSITIVE_FIELD_PATTERN =
  /authorization|proxy-authorization|set-cookie|cookie|token|passwd|password|secret|credential|api[-_]?key|private[-_]?key|signature|ticket/i;

/** 文本键值对中视为凭据的键名。 */
const SENSITIVE_TEXT_KEYS = [
  'authorization',
  'proxy-authorization',
  'set-cookie',
  'cookie',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'bot_token',
  'passwd',
  'password',
  'secret',
  'client[-_]?secret',
  'credential',
  'api[-_]?key',
  'private[-_]?key',
  'signature',
  'ticket'
].join('|');

/** `Bearer <credential>` / `Basic <credential>`：认证方案保留，凭据替换。 */
const BEARER_TEXT_PATTERN = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi;

/**
 * 文本键值对：覆盖查询串/表单（`?token=x&a=1`）、JSON/TOML（`"token": "x"`）
 * 与日志中的 `token=x` 写法。键名前的分隔符保留，值按引号形态替换。
 */
const KEY_VALUE_TEXT_PATTERN = new RegExp(
  `(^|[\\s,;?&{\\[\\(])(["']?(?:${SENSITIVE_TEXT_KEYS})["']?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;&}"'\\]\\[]+)`,
  'gi'
);

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 100;
const TRUNCATED = '[Truncated]';
const CIRCULAR = '[Circular]';

/** 字段名是否属于凭据类，供结构化脱敏使用。 */
export function isSensitiveLogKey(key: string): boolean {
  return SENSITIVE_FIELD_PATTERN.test(key);
}

/**
 * 脱敏单段文本：
 * 1. 先替换认证方案后的凭据（`Authorization: Bearer x`、裸 `Bearer x`）；
 * 2. 再替换凭据键值对，保留原始引号与键名分隔符。
 *
 * 已替换后的 `[REDACTED]` 不会再次命中键值规则。
 */
export function redactLogText(text: string): string {
  if (!text) return text;
  return text
    .replace(BEARER_TEXT_PATTERN, (match) => {
      const separator = match.indexOf(' ');
      return `${match.slice(0, separator)} ${REDACTED}`;
    })
    .replace(KEY_VALUE_TEXT_PATTERN, (_match, prefix: string, label: string, value: string) => {
      const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : '';
      return `${prefix}${label}${quote}${REDACTED}${quote}`;
    });
}

/**
 * 脱敏任意日志数据。返回值总是新结构，原对象保持不变；
 * Error 只保留名称与脱敏后的 message，不携带堆栈（避免把调用路径一并写入日志）。
 */
export function redactLogData(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (typeof value === 'string') return redactLogText(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return value.toString();
  if (value === null || typeof value !== 'object') return value;

  if (value instanceof Error) {
    return { name: value.name, message: redactLogText(value.message) };
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (depth >= MAX_DEPTH) return TRUNCATED;
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map(item => redactLogData(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
    }
    return items;
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSensitiveLogKey(key) ? REDACTED : redactLogData(item, depth + 1, seen);
  }
  return result;
}
