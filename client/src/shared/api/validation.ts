/**
 * 通用载荷守卫
 * 只描述 JSON 的结构，不感知任何业务端点。
 */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
