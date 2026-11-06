import type { OperProgressPlan } from '../types'

export const OPER_PROGRESS_ROLES = [
  { value: 'Unknown', label: '自动识别职业' },
  { value: 'Pioneer', label: '先锋' },
  { value: 'Warrior', label: '近卫' },
  { value: 'Tank', label: '重装' },
  { value: 'Sniper', label: '狙击' },
  { value: 'Caster', label: '术师' },
  { value: 'Medic', label: '医疗' },
  { value: 'Support', label: '辅助' },
  { value: 'Special', label: '特种' },
]

const isIntegerBetween = (value: unknown, min: number, max: number) => (
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
)

export function validateOperProgressPlans(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return '游戏内培养需要添加至少一项培养计划'
  for (const [index, plan] of value.entries()) {
    const prefix = `培养计划 ${index + 1}：`
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return `${prefix}计划格式无效`
    if (typeof plan.name !== 'string' || !plan.name.trim()) return `${prefix}请填写干员姓名`
    if (plan.role !== undefined && !OPER_PROGRESS_ROLES.some(role => role.value === plan.role)) return `${prefix}请选择有效职业`
    if (plan.elite !== undefined && !isIntegerBetween(plan.elite, 1, 2)) return `${prefix}精英目标应为 1 或 2`
    if (plan.skill_level !== undefined && !isIntegerBetween(plan.skill_level, 2, 7)) return `${prefix}技能等级应为 2 至 7`
    if (plan.skill_mastery !== undefined && (
      !Array.isArray(plan.skill_mastery) || plan.skill_mastery.length !== 3
      || !plan.skill_mastery.every((level: unknown) => isIntegerBetween(level, 0, 3))
    )) return `${prefix}专精目标应为三个 0 至 3 的整数`
    if (plan.elite === undefined && plan.skill_level === undefined
      && !plan.skill_mastery?.some((level: number) => level > 0)) return `${prefix}请至少选择一个培养目标`
  }
  return null
}

export function validateThemes(value: unknown): string | null {
  return Array.isArray(value) && value.length > 0
    && value.every(theme => typeof theme === 'string' && theme.trim())
    ? null
    : '更换游戏主题需要填写至少一个主题名，请删除空白主题'
}

export function updateOperProgressTarget(
  plan: OperProgressPlan,
  key: 'elite' | 'skill_level',
  value: string,
): OperProgressPlan {
  const next = { ...plan }
  if (value === '') delete next[key]
  else next[key] = Number(value)
  return next
}

export function updateOperProgressMastery(plan: OperProgressPlan, skill: number, value: string): OperProgressPlan {
  const next = { ...plan }
  const mastery: [number, number, number] = [...(plan.skill_mastery ?? [0, 0, 0])]
  mastery[skill] = Number(value)
  if (mastery.some(level => level > 0)) next.skill_mastery = mastery
  else delete next.skill_mastery
  return next
}

export const FIGHT_SERIES_MIN = -1
export const FIGHT_SERIES_MAX = 10

function optionalInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : Number.NaN
}

export function validateFightSeries(value: unknown): string | null {
  const parsed = optionalInteger(value)
  if (parsed === null) return null
  return Number.isNaN(parsed) || parsed < FIGHT_SERIES_MIN || parsed > FIGHT_SERIES_MAX
    ? `连战倍率应为 ${FIGHT_SERIES_MIN} 至 ${FIGHT_SERIES_MAX} 的整数`
    : null
}

export function validateFightMedicineExpireDays(value: unknown): string | null {
  const parsed = optionalInteger(value)
  if (parsed === null) return null
  return Number.isNaN(parsed) || parsed < 0 ? '临期药天数应为不小于 0 的整数' : null
}

export function validateRecruitPermitReserve(value: unknown): string | null {
  const parsed = optionalInteger(value)
  if (parsed === null) return null
  return Number.isNaN(parsed) || parsed < 0 ? '3 星保留招聘许可应为不小于 0 的整数' : null
}

export function validateRecruitExtraTagsMode(value: unknown): string | null {
  const parsed = optionalInteger(value)
  if (parsed === null) return null
  return Number.isNaN(parsed) || ![0, 1, 2].includes(parsed) ? '公招多选 Tag 策略无效' : null
}
