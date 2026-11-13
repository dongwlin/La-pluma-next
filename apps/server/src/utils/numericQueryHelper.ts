/**
 * 省略或非法输入回落默认值；有限数值截断为整数并夹取到 [min, max]，重复参数、Infinity、
 * 负数、小数与超大值都有确定且受限的结果。
 */

export interface BoundedIntegerBounds {
  defaultValue: number;
  min: number;
  max: number;
}

/** 把未知的查询值归一化为受界整数；输入类型保持 unknown，由本函数完成收窄。 */
export function resolveBoundedInteger(
  value: unknown,
  { defaultValue, min, max }: BoundedIntegerBounds
): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return defaultValue;
  }
  return Math.min(Math.max(Math.trunc(numeric), min), max);
}
