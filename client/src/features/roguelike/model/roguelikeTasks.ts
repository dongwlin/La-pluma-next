/**
 * 肉鸽任务目录、选项解析与命令纯模型
 *
 * 页面与面板只提供当前草稿，模型不读取配置通道、执行控制器或任何 React 状态：
 *
 * - `ROGUELIKE_TASKS` 是模式选择器与配置表单共用的任务目录；
 * - `ROGUELIKE_THEME_PRESETS` 只描述界面上可点的主题快捷项，服务端载荷仍以
 *   `taskInputs` 里的主题代号为准；
 * - 字段表与主题相关候选项由 `roguelikeOptions` 维护，本模块负责可见性、
 *   默认值、命令拼接与输入校验；
 * - 输入校验要求两个已知模式有非空主题，刷坍缩范式模式还要求填写期望范式。
 */

import {
  MAA_CLI_I32_MAX,
  MAA_CLI_I32_MIN,
  getRoguelikeAdvancedOptions,
  getRoguelikeOptionChoices,
} from './roguelikeOptions'
import type {
  RoguelikeAdvancedOption,
  RoguelikeAdvancedParams,
  RoguelikeAdvancedValues,
  RoguelikeMode,
  RoguelikeTask,
  RoguelikeTaskInputs,
} from '../types'

export { getRoguelikeAdvancedOptions, getRoguelikeOptionChoices } from './roguelikeOptions'

export const DEFAULT_ROGUELIKE_MODE: RoguelikeMode = 'roguelike'

/**
 * 生息演算默认模式与 CLI 一致：`-m` 缺省为 1（有存档时制作工具）。
 * 模式 0 仅在没有存档时使用，已有存档时可能丢失进度。
 */
export const DEFAULT_RECLAMATION_MODE = '1'

export const ROGUELIKE_TASKS: readonly RoguelikeTask[] = [
  {
    id: 'roguelike',
    name: '集成战略',
    command: 'roguelike',
    placeholder: '输入主题代号',
    icon: 'Map',
    hasAdvanced: true,
    description: '自动刷集成战略（肉鸽），支持多个主题',
  },
  {
    id: 'reclamation',
    name: '生息演算',
    command: 'reclamation',
    placeholder: '输入主题代号',
    icon: 'Plant',
    hasAdvanced: true,
    description: '自动生息演算模式',
  },
]

export interface RoguelikeThemePreset {
  value: string
  label: string
}

/** 界面上的主题快捷项；模式与配置 key 保持一致。 */
export const ROGUELIKE_THEME_PRESETS: Record<RoguelikeMode, readonly RoguelikeThemePreset[]> = {
  roguelike: [
    { value: 'Phantom', label: '傀影' },
    { value: 'Mizuki', label: '水月' },
    { value: 'Sami', label: '萨米' },
    { value: 'Sarkaz', label: '萨卡兹' },
    { value: 'JieGarden', label: '界园' },
  ],
  reclamation: [
    { value: 'Tales', label: '沙洲遗闻' },
  ],
}

/** 显式值优先；未设置或空字符串回落到选项声明的默认值。 */
function pickAdvancedValue(
  option: RoguelikeAdvancedOption,
  advanced: RoguelikeAdvancedValues,
): string | number | boolean | undefined {
  const value = advanced[option.key]
  if (value === undefined || value === '') return option.defaultValue
  return value
}

/**
 * 字段的显示值：先按默认值解析，再回落到当前主题下 select 的首项。
 * 命令构造不使用首项回落——未声明默认值的字段保持省略。
 */
export function resolveRoguelikeAdvancedValue(
  option: RoguelikeAdvancedOption,
  advanced: RoguelikeAdvancedValues,
  theme = '',
): string | number | boolean | undefined {
  return pickAdvancedValue(option, advanced)
    ?? getRoguelikeOptionChoices(option, theme)?.[0]?.value
}

/** 下拉字段的取值是否属于当前主题的候选表；非下拉字段不做取值约束。 */
export function isRoguelikeOptionValueValid(
  option: RoguelikeAdvancedOption,
  theme: string,
  value: string | number | boolean,
): boolean {
  if (option.type !== 'select') return true
  const choices = getRoguelikeOptionChoices(option, theme)
  if (!choices) return true
  return choices.some(choice => choice.value === String(value))
}

/** number 字段的取值错误：只接受整数且落在字段范围内；空值表示未设置。 */
function getRoguelikeNumberError(
  option: RoguelikeAdvancedOption,
  value: string | number | boolean,
): string | null {
  const text = String(value).trim()
  if (text === '') return null
  if (!/^[+-]?\d+$/.test(text)) return `${option.label}需为整数`

  const parsed = Number(text)
  const min = option.numberRange?.min ?? MAA_CLI_I32_MIN
  const max = option.numberRange?.max ?? MAA_CLI_I32_MAX
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return `${option.label}需在 ${min}–${max} 之间`
  }
  return null
}

/** 返回第一个生效但取值越界的字段错误；没有越界值时为 null。 */
function findInvalidOptionValue(
  taskId: string,
  theme: string,
  advanced: RoguelikeAdvancedValues,
): string | null {
  for (const option of getRoguelikeAdvancedOptions(taskId)) {
    if (!isRoguelikeOptionVisible(option, taskId, theme, advanced)) continue

    const value = pickAdvancedValue(option, advanced)
    if (value === undefined || value === '') continue

    if (option.type === 'number') {
      const error = getRoguelikeNumberError(option, value)
      if (error) return error
      continue
    }

    if (option.type !== 'select') continue
    if (isRoguelikeOptionValueValid(option, theme, value)) continue
    return `${option.label}「${String(value)}」不在当前主题的可选范围内，请重新选择`
  }
  return null
}

/** 模式取值：缺省按当前主题的首项解析，与界面显示一致。 */
function resolveModeValue(taskId: string, theme: string, advanced: RoguelikeAdvancedValues): string {
  const modeOption = getRoguelikeAdvancedOptions(taskId).find(option => option.key === 'mode')
  if (!modeOption) return ''
  const value = resolveRoguelikeAdvancedValue(modeOption, advanced, theme)
  return value === undefined ? '' : String(value)
}

/**
 * 字段是否在当前主题与模式下生效。
 *
 * 主题取自任务输入（trim 后比较），模式与依赖字段按显示值解析：
 * 这样面板显示与命令下发判断同一份状态，隐藏字段的残留值不会写进命令。
 */
export function isRoguelikeOptionVisible(
  option: RoguelikeAdvancedOption,
  taskId: string,
  theme: string,
  advanced: RoguelikeAdvancedValues,
): boolean {
  const normalizedTheme = theme.trim()
  if (option.themes && !option.themes.includes(normalizedTheme)) return false

  if (option.modes && !option.modes.includes(resolveModeValue(taskId, normalizedTheme, advanced))) {
    return false
  }

  const requires = option.requires
  if (!requires) return true

  const target = getRoguelikeAdvancedOptions(taskId).find(candidate => candidate.key === requires.key)
  if (!target) return true
  const value = resolveRoguelikeAdvancedValue(target, advanced, normalizedTheme)

  if (requires.oneOf) return requires.oneOf.includes(String(value ?? ''))
  if (typeof requires.equals === 'boolean') return Boolean(value) === requires.equals
  if (typeof requires.equals === 'string') return String(value ?? '') === requires.equals
  return Boolean(value)
}

/**
 * 主题切换后把当前主题不再支持的模式重置为首项（集成战略的刷坍缩范式只对萨米开放）。
 * 其余字段保留原值；仍生效但越界的下拉值交由执行前校验拒绝。
 */
export function normalizeRoguelikeModeForTheme(
  taskId: string,
  theme: string,
  advancedParams: RoguelikeAdvancedParams,
): RoguelikeAdvancedParams {
  const modeOption = getRoguelikeAdvancedOptions(taskId).find(option => option.key === 'mode')
  if (!modeOption) return advancedParams

  const advanced = advancedParams[taskId] ?? {}
  const mode = resolveModeValue(taskId, theme, advanced)
  if (!mode) return advancedParams

  const choices = getRoguelikeOptionChoices(modeOption, theme) ?? []
  if (choices.some(choice => choice.value === mode)) return advancedParams
  return { ...advancedParams, [taskId]: { ...advanced, mode: choices[0]?.value ?? '' } }
}

/** 列表参数按逗号、顿号、分号与空白切分；空串与重复分隔符不产生参数。 */
export function splitRoguelikeListValue(value: unknown): string[] {
  if (typeof value !== 'string' && typeof value !== 'number') return []
  return String(value)
    .split(/[，,、;；\s]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

/**
 * 补齐声明了默认值但缺失或为空的字段。返回新对象，且只在确有补齐时复制；
 * 不修改入参，无变化时返回原引用以便草稿等价判断保持稳定。
 */
export function normalizeRoguelikeAdvancedParams(
  advancedParams: RoguelikeAdvancedParams,
): RoguelikeAdvancedParams {
  let normalized: RoguelikeAdvancedParams | null = null

  for (const { id: taskId } of ROGUELIKE_TASKS) {
    const defaults = getRoguelikeAdvancedOptions(taskId)
      .filter(option => option.defaultValue !== undefined)
    if (defaults.length === 0) continue

    const current = advancedParams[taskId]
    let taskValues: RoguelikeAdvancedValues | null = null
    for (const option of defaults) {
      const value = current?.[option.key]
      if (value !== undefined && value !== '') continue
      if (taskValues === null) taskValues = { ...current }
      taskValues[option.key] = option.defaultValue as string
    }
    if (taskValues === null) continue

    if (normalized === null) normalized = { ...advancedParams }
    normalized[taskId] = taskValues
  }

  return normalized ?? advancedParams
}

/**
 * 拼接执行参数：主题代号在前，字段按字段表顺序追加。
 * 空字符串、未勾选的 checkbox、未设置的字段、当前主题/模式不适用的字段、
 * 越界的下拉值与非法整数不写入；声明了默认值的字段在缺失或为空时解析为默认值并始终写入。
 */
export function buildRoguelikeCommandParams(
  taskId: string,
  taskInputs: RoguelikeTaskInputs,
  advancedParams: RoguelikeAdvancedParams,
): string {
  const theme = taskInputs[taskId] || ''
  const advanced = advancedParams[taskId] || {}
  let params = theme

  for (const option of getRoguelikeAdvancedOptions(taskId)) {
    if (!isRoguelikeOptionVisible(option, taskId, theme, advanced)) continue

    const value = pickAdvancedValue(option, advanced)
    if (value === undefined || value === '' || value === false) continue
    if (option.type === 'select' && !isRoguelikeOptionValueValid(option, theme, value)) continue

    if (option.type === 'checkbox') {
      if (value === true) params += ` ${option.param}`
      continue
    }

    if (option.type === 'number') {
      if (getRoguelikeNumberError(option, value)) continue
      const numeric = String(value).trim()
      if (numeric === '') continue
      params += ` ${option.param} ${numeric}`
      continue
    }

    if (option.type === 'list') {
      for (const item of splitRoguelikeListValue(value)) params += ` ${option.param} ${item}`
      continue
    }

    params += ` ${option.param} ${value}`
  }

  return params
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
  const advanced = advancedParams[taskId] ?? {}
  const invalidValue = findInvalidOptionValue(taskId, theme, advanced)
  if (invalidValue) return invalidValue
  if (taskId !== 'roguelike') return null

  if (resolveModeValue('roguelike', theme, advanced) !== '5') return null
  if (splitRoguelikeListValue(advanced.expectedCollapsalParadigms).length > 0) return null
  return '刷坍缩范式模式需要填写期望坍缩范式'
}
