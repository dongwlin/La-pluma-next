/**
 * 数值查询参数归一化
 *
 * 统一日志、掉落和运行快照等数值 query 的边界策略：省略或非法输入（abc、NaN、
 * Infinity 等非有限数值、多元素数组等 Number() 结果非有限的值）回落到默认值；
 * 有限数值截断为整数并夹取到 [min, max]。重复参数、Infinity、负数、小数和
 * 超大值因此都有确定且受限的结果，与运行快照既有的行数归一化语义一致。
 */

/** 归一化边界：默认值用于省略/非法输入，min/max 是夹取范围。 */
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
