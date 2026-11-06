import type {
  RoguelikeAdvancedOption,
  RoguelikeAdvancedParams,
  RoguelikeAdvancedValues,
  RoguelikeTaskInputs,
} from '../types'
import { getBlackflowRewardChoices, getRoguelikeAdvancedOptions } from './roguelikeOptions'
import {
  buildRoguelikeCommandParams,
  getRoguelikeListError,
  getRoguelikeNumberError,
  getTaskDefinition,
  isRoguelikeOptionValueValid,
  isRoguelikeOptionVisible,
  pickAdvancedValue,
  resolveListChoice,
  resolveModeValue,
  splitRoguelikeListValue,
} from './roguelikeTasks'

export interface RoguelikeDynamicTaskConfig {
  name: string
  type: 'Roguelike' | 'Reclamation'
  params: Record<string, unknown>
}

export interface RoguelikeExecutionPlan {
  command: string
  params: string
  taskConfig: RoguelikeDynamicTaskConfig | null
}

const CLI_ROGUELIKE_THEMES: ReadonlySet<string> = new Set(['Phantom', 'Mizuki', 'Sami', 'Sarkaz', 'JieGarden'])
const CLI_ROGUELIKE_MODES: ReadonlySet<string> = new Set(['0', '1', '4', '5', '6', '7'])
const CLI_RECLAMATION_THEMES: ReadonlySet<string> = new Set(['Tales'])
const CLI_RECLAMATION_MODES: ReadonlySet<string> = new Set(['0', '1'])

const BLACKFLOW_ANIMAL_PARAM = 'blackflow_start_animals'
const BLACKFLOW_REWARD_PARAM = 'blackflow_start_rewards'

function optionHasConfiguredValue(
  option: RoguelikeAdvancedOption,
  advanced: RoguelikeAdvancedValues,
  theme: string,
  taskId: string,
): boolean {
  const value = pickAdvancedValue(option, advanced, theme, taskId)
  return value !== undefined && value !== '' && value !== false
}

/**
 * 当前选择是否有 CLI 无法表达的部分：主题或模式不在 maa-cli 的枚举里，
 * 或生效的字段只声明了 Core 参数名。满足时只能走动态任务。
 */
export function requiresRoguelikeDynamicTask(
  taskId: string,
  taskInputs: RoguelikeTaskInputs,
  advancedParams: RoguelikeAdvancedParams,
): boolean {
  const theme = (taskInputs[taskId] || '').trim()
  const advanced = advancedParams[taskId] ?? {}
  const mode = resolveModeValue(taskId, theme, advanced)

  if (taskId === 'reclamation') {
    if (!CLI_RECLAMATION_THEMES.has(theme)) return true
    if (!CLI_RECLAMATION_MODES.has(mode)) return true
  } else {
    if (!CLI_ROGUELIKE_THEMES.has(theme)) return true
    if (!CLI_ROGUELIKE_MODES.has(mode)) return true
  }

  return getRoguelikeAdvancedOptions(taskId).some(option => (
    option.param === undefined
    && isRoguelikeOptionVisible(option, taskId, theme, advanced)
    && optionHasConfiguredValue(option, advanced, theme, taskId)
  ))
}

function toCoreNumber(value: string | number | boolean): number {
  return Number(String(value).trim())
}

function toCoreStringList(option: RoguelikeAdvancedOption, value: string | number | boolean): string[] {
  const items = splitRoguelikeListValue(value)
  if (option.listChoices) {
    return items.map(item => resolveListChoice(option, item) ?? item)
  }
  return items
}

function toRewardBitmask(option: RoguelikeAdvancedOption, value: string | number | boolean): number {
  const rewards = getBlackflowRewardChoices()
  let mask = 0
  for (const item of splitRoguelikeListValue(value)) {
    const token = resolveListChoice(option, item)
    const index = rewards.findIndex(reward => reward.value === token)
    if (index >= 0) mask |= 1 << index
  }
  return mask
}

function toCoreValue(
  option: RoguelikeAdvancedOption,
  value: string | number | boolean,
): unknown {
  const coreType = option.coreType
    ?? (option.type === 'number'
      ? 'number'
      : option.type === 'checkbox'
        ? 'boolean'
        : option.type === 'list'
          ? 'string-list'
          : 'string')

  switch (coreType) {
    case 'number':
      return toCoreNumber(value)
    case 'boolean': {
      const enabled = Boolean(value)
      return option.coreInvert ? !enabled : enabled
    }
    case 'string-list':
      return toCoreStringList(option, value)
    case 'reward-bitmask':
      return toRewardBitmask(option, value)
    default:
      return String(value).trim()
  }
}

/**
 * 构造 Core 动态任务参数：与命令构造读取同一份字段表，只把生效字段换成 Core 键。
 * 缺省值与 CLI 不一致的字段在此显式补齐（CLI 默认在投资满时停止），
 * 刷开局模式的两个必填项即使为空也写入。
 */
export function buildRoguelikeDynamicTaskConfig(
  taskId: string,
  taskInputs: RoguelikeTaskInputs,
  advancedParams: RoguelikeAdvancedParams,
): RoguelikeDynamicTaskConfig {
  const task = getTaskDefinition(taskId)
  const theme = (taskInputs[taskId] || '').trim()
  const advanced = advancedParams[taskId] ?? {}
  const mode = resolveModeValue(taskId, theme, advanced)
  const params: Record<string, unknown> = { theme }

  for (const option of getRoguelikeAdvancedOptions(taskId)) {
    if (!isRoguelikeOptionVisible(option, taskId, theme, advanced)) continue
    const value = pickAdvancedValue(option, advanced, theme, taskId)
    if (value === undefined || value === '' || value === false) continue
    if (option.type === 'select' && !isRoguelikeOptionValueValid(option, theme, value, taskId)) continue
    if (option.type === 'number' && getRoguelikeNumberError(option, value)) continue
    if (option.type === 'list' && getRoguelikeListError(option, value)) continue
    params[option.coreParam] = toCoreValue(option, value)
  }

  if (taskId === 'roguelike' && params.stop_when_investment_full === undefined) {
    const disableInvestment = getRoguelikeAdvancedOptions(taskId)
      .find(option => option.key === 'disableInvestment')
    if (disableInvestment && pickAdvancedValue(disableInvestment, advanced, theme, taskId) !== true) {
      params.stop_when_investment_full = true
    }
  }

  if (taskId === 'roguelike' && theme === 'BlackFlow' && mode === '30003') {
    if (params[BLACKFLOW_ANIMAL_PARAM] === undefined) params[BLACKFLOW_ANIMAL_PARAM] = []
    if (params[BLACKFLOW_REWARD_PARAM] === undefined) params[BLACKFLOW_REWARD_PARAM] = 0
  }

  return {
    name: task.name,
    type: taskId === 'reclamation' ? 'Reclamation' : 'Roguelike',
    params,
  }
}

/**
 * 执行计划：CLI 能表达时保持原命令；否则改用 `run` + taskConfig 动态任务。
 * 动态任务的 `params` 是临时任务文件名前缀，服务端要求只含字母、数字、下划线和连字符。
 */
export function buildRoguelikeExecutionPlan(
  taskId: string,
  taskInputs: RoguelikeTaskInputs,
  advancedParams: RoguelikeAdvancedParams,
): RoguelikeExecutionPlan {
  const task = getTaskDefinition(taskId)
  if (requiresRoguelikeDynamicTask(taskId, taskInputs, advancedParams)) {
    return {
      command: 'run',
      params: taskId,
      taskConfig: buildRoguelikeDynamicTaskConfig(taskId, taskInputs, advancedParams),
    }
  }
  return {
    command: task.command,
    params: buildRoguelikeCommandParams(taskId, taskInputs, advancedParams),
    taskConfig: null,
  }
}
