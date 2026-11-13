import type { RoguelikeAdvancedOption, RoguelikeSelectOption } from '../types'
import {
  difficultyChoices,
  modeChoices,
  roleChoices,
  squadChoices,
} from './roguelikeOptionCatalog'
import { ROGUELIKE_OPTIONS } from './roguelikeOptionTables'
import { RECLAMATION_OPTIONS } from './reclamationOptionTables'

export { MAA_CLI_I32_MAX, MAA_CLI_I32_MIN } from './roguelikeOptionCatalog'
export { ROGUELIKE_THEMES, RECLAMATION_THEMES } from './roguelikeOptionCatalog'
export { getBlackflowAnimalChoices, getBlackflowRewardChoices } from './roguelikeOptionCatalog'

const OPTION_TABLES: Record<string, readonly RoguelikeAdvancedOption[]> = {
  roguelike: ROGUELIKE_OPTIONS,
  reclamation: RECLAMATION_OPTIONS,
}

export function getRoguelikeAdvancedOptions(taskId: string): RoguelikeAdvancedOption[] {
  return [...(OPTION_TABLES[taskId] ?? [])]
}

/**
 * 字段的实际下拉项：主题相关的 select 由 choices 解析，其余沿用静态 options。
 * 未知主题按最保守的通用列表处理。
 */
export function getRoguelikeOptionChoices(
  option: RoguelikeAdvancedOption,
  theme: string,
  taskId = 'roguelike',
): RoguelikeSelectOption[] | undefined {
  // 主题输入允许带空白，候选项按 trim 后的代号匹配，与可见性判断保持一致。
  const normalizedTheme = theme.trim()
  switch (option.choices) {
    case 'modes':
      return modeChoices(normalizedTheme, taskId)
    case 'difficulty':
      return difficultyChoices(normalizedTheme)
    case 'squads':
      return squadChoices(normalizedTheme)
    case 'roles':
      return roleChoices(normalizedTheme)
    default:
      return option.options ? [...option.options] : undefined
  }
}
