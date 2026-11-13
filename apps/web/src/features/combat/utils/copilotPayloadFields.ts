import { isRecord } from '@/shared/api'
import type { CopilotDetailOperator } from '../types'

/** 作业站载荷的字段收窄助手：详情、作业集、计划与搜索条目共用同一套读取规则。 */

export const asText = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value : undefined
)

export const asNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
)

export const asCount = (value: unknown, minimum = 0): number | null => (
  typeof value === 'number' && Number.isInteger(value) && value >= minimum ? value : null
)

export const asId = (value: unknown): number | null => {
  const numeric = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null
}

export const asModule = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

export const compactFields = <T extends Record<string, unknown>>(value: T): T => (
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ''),
  ) as T
)

export function readUnique<T>(values: readonly unknown[], read: (value: unknown) => T | undefined): T[] {
  const items: T[] = []
  for (const raw of values) {
    const item = read(raw)
    if (item !== undefined && !items.includes(item)) items.push(item)
  }
  return items
}

export const readGroupNames = (value: unknown): string[] => (
  Array.isArray(value) ? readUnique(value, raw => (isRecord(raw) ? asText(raw.name) : undefined)) : []
)

export const readOperators = (value: unknown): string[] => (
  Array.isArray(value) ? readUnique(value, raw => asText(raw)) : []
)

/** 详情载荷把练度放在 `requirements` 下，搜索条目投影后是扁平字段，两种形状都接受。 */
export function readOperatorDetails(value: unknown): CopilotDetailOperator[] {
  if (!Array.isArray(value)) return []
  const details: CopilotDetailOperator[] = []
  for (const raw of value) {
    if (!isRecord(raw)) continue
    const name = asText(raw.name)
    if (!name) continue
    const requirements = isRecord(raw.requirements) ? raw.requirements : raw
    details.push(compactFields({
      name,
      group: asText(raw.group),
      elite: asNumber(requirements.elite),
      level: asNumber(requirements.level),
      skillLevel: asNumber(requirements.skill_level ?? requirements.skillLevel),
      module: asModule(requirements.module),
    }))
  }
  return details
}
