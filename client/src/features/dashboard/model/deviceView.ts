/**
 * 总览设备卡的展示投影
 *
 * 使用率阈值与温度曲线几何都脱离 React 计算：采样本身仍由 device-mirror
 * 的 Query 持有，`dashboardStore` 仍负责语义校验与温度历史。
 */

export type UsageTone = 'danger' | 'warning' | 'normal'

/** 使用率只影响颜色语义，不改变数值或进度条宽度。 */
export function getUsageTone(pct?: number | null): UsageTone {
  if (pct == null) return 'normal'
  if (pct >= 90) return 'danger'
  if (pct >= 75) return 'warning'
  return 'normal'
}

export interface TemperatureSeries {
  /** 用于 aria 文案的原始最小/最大值。 */
  readonly min: number
  readonly max: number
  /** SVG 折线点，坐标范围 x 0–100、y 0–28。 */
  readonly points: string
  readonly areaPoints: string
  readonly lastPoint: readonly string[] | null
  /** “近 N 秒”区间文案；单点也按一次采样间隔展示。 */
  readonly durationLabel: string
}

/**
 * 一个样本绘制为水平直线：只保留一个点时复制为两个相同值，稳定区间自动
 * 增加 ±1 的纵向余量，避免除零和贴边。
 */
export function buildTemperatureSeries(values: number[]): TemperatureSeries | null {
  const chartValues = values.length > 1 ? values : values.length === 1 ? [values[0]!, values[0]!] : []
  if (chartValues.length === 0) return null

  const min = Math.min(...chartValues)
  const max = Math.max(...chartValues)
  const isStable = max - min < 0.1
  const chartMin = isStable ? min - 1 : min
  const chartMax = isStable ? max + 1 : max
  const spread = chartMax - chartMin
  const points = chartValues.map((value, index) => {
    const x = chartValues.length === 1 ? 0 : (index / (chartValues.length - 1)) * 100
    const y = 25 - ((value - chartMin) / spread) * 18
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  const areaPoints = `0,28 ${points} 100,28`

  return {
    min,
    max,
    points,
    areaPoints,
    lastPoint: points.split(' ').slice(-1)[0]?.split(',') ?? null,
    durationLabel: `近 ${Math.max(5, (values.length - 1) * 5)} 秒`,
  }
}
