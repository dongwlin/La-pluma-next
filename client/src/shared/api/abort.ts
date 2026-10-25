/**
 * 取消判断
 * 浏览器的 `fetch` 在 jsdom/不同实现下可能抛 `DOMException` 或 `Error`，
 * 不能用 `instanceof Error` 判断，否则取消会被误报成连接失败。
 */

export const isAbortError = (error: unknown): boolean =>
  Boolean(error) && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError'
