import type { OperatorDetailed } from '@/features/game-data'
import type { OperatorPickerOption, OperatorSortDirection } from '../types'

export type OperatorProfessionFilter =
  | 'all'
  | 'PIONEER'
  | 'WARRIOR'
  | 'TANK'
  | 'SNIPER'
  | 'CASTER'
  | 'MEDIC'
  | 'SUPPORT'
  | 'SPECIAL'

export interface OperatorProfessionFilterOption {
  value: OperatorProfessionFilter
  label: string
}

/** 职业枚举与「数据统计」干员面板一致；「全部」保持默认。 */
export const OPERATOR_PROFESSION_FILTERS: readonly OperatorProfessionFilterOption[] = [
  { value: 'all', label: '全部' },
  { value: 'PIONEER', label: '先锋' },
  { value: 'WARRIOR', label: '近卫' },
  { value: 'TANK', label: '重装' },
  { value: 'SNIPER', label: '狙击' },
  { value: 'CASTER', label: '术师' },
  { value: 'MEDIC', label: '医疗' },
  { value: 'SUPPORT', label: '辅助' },
  { value: 'SPECIAL', label: '特种' },
]

/**
 * 把识别快照或全量目录条目归一为选择器行；缺失的可选字段保持省略。
 * 识别快照的 `own_opers` 带精英/等级但不带职业，职业由同 id 的目录条目补位。
 */
export const toOperatorPickerOption = (
  operator: OperatorDetailed,
  catalogOperator?: OperatorDetailed,
): OperatorPickerOption => {
  const profession = operator.profession || catalogOperator?.profession
  return {
    id: operator.id,
    name: operator.name,
    rarity: operator.rarity,
    ...(profession ? { profession } : {}),
    ...(typeof operator.elite === 'number' ? { elite: operator.elite } : {}),
    ...(typeof operator.level === 'number' ? { level: operator.level } : {}),
  }
}

/** 职业筛选；`all` 返回新数组，具体职业按目录枚举精确匹配，未知职业不出现在具名筛选中。 */
export const filterOperatorOptionsByProfession = (
  options: readonly OperatorPickerOption[],
  profession: OperatorProfessionFilter,
): OperatorPickerOption[] => {
  if (profession === 'all') return [...options]
  return options.filter(option => option.profession === profession)
}

const eliteOf = (operator: OperatorPickerOption): number => (
  typeof operator.elite === 'number' ? operator.elite : 0
)

const levelOf = (operator: OperatorPickerOption): number => (
  typeof operator.level === 'number' ? operator.level : 0
)

/**
 * 默认排序：精英阶段优先，同精英内按等级，方向由调用方决定。
 * 练度相同或缺失时按稀有度降序、名称与 id 升序兜底；缺失练度按 0 处理，
 * 因此没有识别数据的目录条目仍保持确定的目录顺序，不会随渲染抖动。
 */
export const sortOperatorPickerOptions = (
  options: readonly OperatorPickerOption[],
  direction: OperatorSortDirection,
): OperatorPickerOption[] => {
  const factor = direction === 'desc' ? -1 : 1
  return [...options].sort((left, right) => {
    const byElite = factor * (eliteOf(left) - eliteOf(right))
    if (byElite !== 0) return byElite

    const byLevel = factor * (levelOf(left) - levelOf(right))
    if (byLevel !== 0) return byLevel

    if (left.rarity !== right.rarity) return right.rarity - left.rarity

    const byName = left.name.localeCompare(right.name, 'zh-CN')
    if (byName !== 0) return byName

    return left.id.localeCompare(right.id)
  })
}
