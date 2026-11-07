import { resolveOperProgressRole } from './gameTaskParams'
import type { OperProgressPlan } from '../types'

interface OperatorDirectoryEntry {
  id: string
  name: string
  profession?: string
}

/**
 * 计划只保存干员中文名与 Core 职业。全量干员目录存在同名条目（例如三种阿米娅）
 * 时用职业消歧；仍不能唯一确定就返回 null，由调用方保留通用人像占位。
 */
export const resolveOperProgressOperatorId = (
  operators: readonly OperatorDirectoryEntry[],
  plan: Pick<OperProgressPlan, 'name' | 'role'>,
): string | null => {
  const name = plan.name.trim()
  if (!name) return null

  const candidates = operators.filter(operator => operator.name === name)
  if (candidates.length <= 1) return candidates[0]?.id ?? null

  const role = plan.role?.trim()
  if (!role || role === 'Unknown') return null

  const matched = candidates.filter(operator => resolveOperProgressRole(operator.profession) === role)
  return matched.length === 1 ? matched[0]?.id ?? null : null
}
