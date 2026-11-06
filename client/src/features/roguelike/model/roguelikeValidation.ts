import type { RoguelikeAdvancedParams, RoguelikeAdvancedValues, RoguelikeTaskInputs } from '../types'
import {
  getRoguelikeAdvancedOptions,
  getRoguelikeListError,
  getRoguelikeNumberError,
  getThemesForTask,
  isKnownRoguelikeTheme,
  isRoguelikeOptionValueValid,
  isRoguelikeOptionVisible,
  pickAdvancedValue,
  resolveModeValue,
  splitRoguelikeListValue,
} from './roguelikeTasks'

function findInvalidOptionValue(
  taskId: string,
  theme: string,
  advanced: RoguelikeAdvancedValues,
): string | null {
  for (const option of getRoguelikeAdvancedOptions(taskId)) {
    if (!isRoguelikeOptionVisible(option, taskId, theme, advanced)) continue

    const value = pickAdvancedValue(option, advanced, theme, taskId)
    if (value === undefined || value === '') continue

    if (option.type === 'number') {
      const error = getRoguelikeNumberError(option, value)
      if (error) return error
      continue
    }

    if (option.type === 'list') {
      const error = getRoguelikeListError(option, value)
      if (error) return error
      continue
    }

    if (option.type !== 'select') continue
    if (isRoguelikeOptionValueValid(option, theme, value, taskId)) continue
    return `${option.label}「${String(value)}」不在当前主题的可选范围内，请重新选择`
  }
  return null
}

function pickOptionValue(
  taskId: string,
  theme: string,
  advanced: RoguelikeAdvancedValues,
  key: string,
): string {
  const option = getRoguelikeAdvancedOptions(taskId).find(candidate => candidate.key === key)
  if (!option) return ''
  const value = pickAdvancedValue(option, advanced, theme, taskId)
  return value === undefined || value === false ? '' : String(value)
}

function listValue(advanced: RoguelikeAdvancedValues, key: string): string[] {
  return splitRoguelikeListValue(advanced[key])
}

/** 执行前校验；返回 null 表示可以提交。 */
export function validateRoguelikeTaskInput(
  taskId: string,
  taskInputs: RoguelikeTaskInputs,
  advancedParams: RoguelikeAdvancedParams = {},
): string | null {
  if (taskId !== 'roguelike' && taskId !== 'reclamation') return null
  if (!(taskInputs[taskId] || '').trim()) return '请输入主题名称'

  const theme = (taskInputs[taskId] || '').trim()
  if (!isKnownRoguelikeTheme(taskId, theme)) {
    return `未知主题「${theme}」，支持：${getThemesForTask(taskId).join('、')}`
  }

  const advanced = advancedParams[taskId] ?? {}
  const invalidValue = findInvalidOptionValue(taskId, theme, advanced)
  if (invalidValue) return invalidValue
  if (taskId !== 'roguelike') return null

  const mode = resolveModeValue('roguelike', theme, advanced)
  if (mode === '5' && listValue(advanced, 'expectedCollapsalParadigms').length === 0) {
    return '刷坍缩范式模式需要填写期望坍缩范式'
  }
  if (mode === '20001' && !pickOptionValue('roguelike', theme, advanced, 'findPlayTimeTarget')) {
    return '刷常乐节点模式需要选择目标常乐节点'
  }
  if (mode === '0') {
    const strategy = pickOptionValue('roguelike', theme, advanced, 'blackflowStrategy')
    const cultivationTarget = pickOptionValue('roguelike', theme, advanced, 'blackflowCultivationTarget')
    if (cultivationTarget && strategy !== 'baby_animal') {
      return '培育目标动物仅在黑流策略为培育襁褓动物时生效，请调整策略或清空该字段'
    }
  }
  return null
}
