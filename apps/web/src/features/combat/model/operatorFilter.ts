import { pinyin } from 'pinyin-pro'
import type { OperBoxData, OperatorNames } from '@/features/game-data'

export interface OperatorFilterOption {
  id: string
  name: string
  owned: boolean
  rarity?: number
  elite?: number
  level?: number
  names?: OperatorNames
}

export type OperatorFilterSection = 'included' | 'excluded'

export interface OperatorSelection {
  readonly included: readonly string[]
  readonly excluded: readonly string[]
}

const compact = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

const buildSearchForms = (option: OperatorFilterOption): readonly string[] => {
  const forms = new Set<string>()
  for (const value of [option.name, option.names?.en, option.names?.jp, option.names?.kr, option.names?.tw]) {
    if (value) forms.add(compact(value))
  }
  forms.add(compact(pinyin(option.name, { toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('')))
  forms.add(compact(pinyin(option.name, { pattern: 'first', toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('')))
  forms.delete('')
  return [...forms]
}

const searchForms = new WeakMap<OperatorFilterOption, readonly string[]>()

const searchFormsOf = (option: OperatorFilterOption): readonly string[] => {
  const cached = searchForms.get(option)
  if (cached) return cached
  const forms = buildSearchForms(option)
  searchForms.set(option, forms)
  return forms
}

const toFilterOption = (
  option: Pick<OperatorFilterOption, 'id' | 'name' | 'owned' | 'rarity' | 'elite' | 'level' | 'names'>,
): OperatorFilterOption => {
  const built: OperatorFilterOption = {
    id: option.id,
    name: option.name,
    owned: option.owned,
    ...(option.rarity === undefined ? {} : { rarity: option.rarity }),
    ...(option.elite === undefined ? {} : { elite: option.elite }),
    ...(option.level === undefined ? {} : { level: option.level }),
    ...(option.names === undefined ? {} : { names: option.names }),
  }
  searchFormsOf(built)
  return built
}

/** 目录快照优先；没有识别目录时退回已拥有干员，两者都没有时返回空列表。 */
export function buildOperatorFilterOptions(operBox: OperBoxData | null): OperatorFilterOption[] {
  const catalog = operBox?.allOpers ?? []
  if (catalog.length) {
    const details = new Map((operBox?.data ?? []).map(operator => [operator.id, operator]))
    return catalog.map((operator) => {
      const detail = details.get(operator.id)
      return toFilterOption({
        id: operator.id,
        name: operator.name,
        owned: operator.owned,
        rarity: operator.rarity,
        elite: detail?.elite,
        level: detail?.level,
        names: operator.names,
      })
    })
  }
  return (operBox?.data ?? []).map(operator => toFilterOption({
    id: operator.id,
    name: operator.name,
    owned: true,
    rarity: operator.rarity,
    elite: operator.elite,
    level: operator.level,
  }))
}

export function filterOperatorOptions(
  options: readonly OperatorFilterOption[],
  term: string,
): OperatorFilterOption[] {
  const query = compact(term)
  if (!query) return [...options]
  return options.filter(option => searchFormsOf(option).some(form => form.includes(query)))
}

const compareText = (left: string, right: string): number => left.localeCompare(right, 'zh-CN')

const trainingOf = (option: OperatorFilterOption): readonly [number, number] | null => {
  if (option.elite === undefined && option.level === undefined) return null
  return [option.elite ?? -1, option.level ?? -1]
}

/**
 * 拥有状态分界先于练度比较；练度缺失者排在同拥有状态组末尾，
 * 练度相同再按稀有度降序、本地化名称与 id 排序，保证结果稳定确定。
 */
export function orderOperatorFilterOptions(
  options: readonly OperatorFilterOption[],
  section: OperatorFilterSection,
): OperatorFilterOption[] {
  const ownedFirst = section === 'included'
  const trainingDirection = section === 'included' ? -1 : 1
  return [...options].sort((left, right) => {
    if (left.owned !== right.owned) return left.owned === ownedFirst ? -1 : 1
    const leftTraining = trainingOf(left)
    const rightTraining = trainingOf(right)
    if (leftTraining && rightTraining) {
      const byElite = (leftTraining[0] - rightTraining[0]) * trainingDirection
      if (byElite !== 0) return byElite
      const byLevel = (leftTraining[1] - rightTraining[1]) * trainingDirection
      if (byLevel !== 0) return byLevel
    } else if (leftTraining || rightTraining) {
      return leftTraining ? -1 : 1
    }
    const byRarity = (right.rarity ?? -1) - (left.rarity ?? -1)
    if (byRarity !== 0) return byRarity
    return compareText(left.name, right.name) || compareText(left.id, right.id)
  })
}

/** included/excluded 去重并互斥；同名同时出现在两侧时保留 included。 */
export function normalizeOperatorSelection(selection: OperatorSelection): OperatorSelection {
  const included: string[] = []
  for (const raw of selection.included) {
    const name = raw.trim()
    if (name && !included.includes(name)) included.push(name)
  }
  const excluded: string[] = []
  for (const raw of selection.excluded) {
    const name = raw.trim()
    if (name && !included.includes(name) && !excluded.includes(name)) excluded.push(name)
  }
  return { included, excluded }
}
