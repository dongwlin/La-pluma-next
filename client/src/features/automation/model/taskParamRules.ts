/**
 * 自动化任务参数字段规则
 *
 * 公招招募时长按 10 分钟取整并夹取在 60–540 分钟内；非有限输入回退默认值。
 * 规则不读取 React 状态、配置通道或执行控制器，页面只把结果写回草稿。
 */

export const RECRUITMENT_TIME_MIN = 60
export const RECRUITMENT_TIME_MAX = 540
export const RECRUITMENT_TIME_STEP = 10
export const DEFAULT_RECRUITMENT_TIME = 540

/** 与旧输入框失焦归一化一致：先取整到 10 分钟，再夹取上下限。 */
export function normalizeRecruitmentTime(rawValue: unknown): number {
  const value = Number(rawValue)
  if (!Number.isFinite(value)) return DEFAULT_RECRUITMENT_TIME

  const stepped = Math.round(value / RECRUITMENT_TIME_STEP) * RECRUITMENT_TIME_STEP
  return Math.min(RECRUITMENT_TIME_MAX, Math.max(RECRUITMENT_TIME_MIN, stepped))
}
