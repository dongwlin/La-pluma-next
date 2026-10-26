/**
 * 作业命令纯模型
 *
 * 把 CLI 参数拼接、高级选项表、编队/突袭规则、作业集执行选项与输入校验
 * 从页面移出。页面只提供当前配置字段，模型不读取 Query、配置通道或执行状态：
 *
 * - `buildCombatCommandArgs` 先拆分/归一输入，作业集输入未带 s 前缀时按
 *   预览的 `autoAddS` 改写为 `prts://s<id>`，再追加高级参数；
 * - 只有 copilot 会追加 `--formation`；raid 只在 copilot 且非普通模式时追加；
 * - 空值、未勾选的 checkbox 与没有参数名的选项不写入命令行；
 * - 作业集执行选项保持原字段与“app/cli → continuous、manual → manual”映射。
 */

import type { CopilotSetRunMode } from '../api'
import type {
  CombatAdvancedOption,
  CopilotRaid,
  CopilotSetExecutionMode,
  FormationMode,
} from '../types'
import { normalizeRaidValue } from './combatConfig'
import { splitCopilotInputToArgs } from '../utils/copilotUri'

export type AdvancedValues = Record<string, string | number | boolean>

const ADVANCED_OPTIONS: Record<string, CombatAdvancedOption[]> = {
  copilot: [
    { key: 'ignoreRequirements', label: '忽略干员要求', type: 'checkbox', param: '--ignore-requirements' },
    { key: 'loopTimes', label: '循环次数', type: 'number', param: '--loop-times', placeholder: '1' },
    {
      key: 'executionStrategy',
      label: '队列策略',
      type: 'select',
      param: '',
      options: [
        { value: 'continue', label: '失败继续下一个' },
        { value: 'stop', label: '失败后停止' },
      ],
    },
    {
      key: 'formationIndex',
      label: '编队选择',
      type: 'select',
      param: '--formation-index',
      options: [
        { value: '', label: '当前编队' },
        { value: '1', label: '编队 1' },
        { value: '2', label: '编队 2' },
        { value: '3', label: '编队 3' },
        { value: '4', label: '编队 4' },
      ],
    },
    { key: 'addTrust', label: '按信赖值填充空位', type: 'checkbox', param: '--add-trust' },
    { key: 'useSanityPotion', label: '理智不足时使用理智药', type: 'checkbox', param: '--use-sanity-potion' },
    {
      key: 'supportUsage',
      label: '助战使用模式',
      type: 'select',
      param: '--support-unit-usage',
      options: [
        { value: '0', label: '不使用助战' },
        { value: '1', label: '缺一个时使用' },
        { value: '2', label: '使用指定助战' },
        { value: '3', label: '使用随机助战' },
      ],
    },
    { key: 'supportName', label: '助战干员名称', type: 'text', param: '--support-unit-name', placeholder: '干员名称' },
  ],
  ssscopilot: [
    { key: 'loopTimes', label: '循环次数', type: 'number', param: '--loop-times', placeholder: '1' },
  ],
  paradoxcopilot: [
    {
      key: 'executionStrategy',
      label: '队列策略',
      type: 'select',
      param: '',
      options: [
        { value: 'continue', label: '失败继续' },
        { value: 'stop', label: '失败停止' },
      ],
    },
  ],
}

export function getCombatAdvancedOptions(taskId: string): CombatAdvancedOption[] {
  return ADVANCED_OPTIONS[taskId] ?? []
}

/** 旧配置的布尔编队值在加载后仍可能到达页面；与迁移前一致归一为三态。 */
export function normalizeFormationMode(value: unknown): FormationMode {
  if (value === true) return 'on'
  if (value === false) return 'off'
  if (value === 'on' || value === 'off' || value === 'auto') return value
  return 'auto'
}

/**
 * 编队参数只属于 copilot：`auto` 在拆分执行作业集时按调用方要求启用，
 * 其它模式直接决定是否追加。
 */
export function shouldAppendFormation(
  taskId: string,
  formationMode: FormationMode,
  forceForSplitSet = false,
): boolean {
  if (taskId !== 'copilot') return false
  if (formationMode === 'on') return true
  if (formationMode === 'off') return false
  return forceForSplitSet
}

export interface CombatCommandOptions {
  readonly advanced?: AdvancedValues
  readonly formationMode?: FormationMode
  /** 作业集拆分执行时把 auto 视为自动编队。 */
  readonly forceFormation?: boolean
}

/** 追加编队、raid 与高级参数；checkbox 只在 true 时写入。 */
export function appendCombatCommandOptions(
  args: readonly string[],
  taskId: string,
  options: CombatCommandOptions = {},
): string[] {
  const nextArgs = [...args]
  if (shouldAppendFormation(taskId, options.formationMode ?? 'auto', options.forceFormation)) {
    nextArgs.push('--formation')
  }

  const advanced = options.advanced ?? {}
  const raidValue = normalizeRaidValue(advanced.raid)
  if (taskId === 'copilot' && raidValue !== 'normal') {
    nextArgs.push('--raid', raidValue)
  }

  for (const option of getCombatAdvancedOptions(taskId)) {
    const value = advanced[option.key]
    if (!option.param || value === undefined || value === '' || value === false) continue
    if (option.type === 'checkbox' && value === true) nextArgs.push(option.param)
    else if (option.type !== 'checkbox') nextArgs.push(option.param, String(value))
  }

  return nextArgs
}

export interface CombatCommandInput extends CombatCommandOptions {
  readonly input: string
  /** 预览确认为未带 s 前缀的作业集时，把 `prts://<id>` 改为 `prts://s<id>`。 */
  readonly autoAddSetPrefix?: boolean
}

export function buildCombatCommandArgs(taskId: string, input: CombatCommandInput): string[] {
  const args = splitCopilotInputToArgs(input.input)
  if (taskId === 'copilot' && input.autoAddSetPrefix) {
    for (let index = 0; index < args.length; index += 1) {
      args[index] = (args[index] || '').replace(/^prts:\/\/(\d+)$/i, 'prts://s$1')
    }
  }
  return appendCombatCommandOptions(args, taskId, input)
}

/** 作业集执行请求的 options 字段保持迁移前形状。 */
export function buildCopilotSetExecutionOptions(
  advanced: AdvancedValues | undefined,
  formationMode: FormationMode,
): Record<string, unknown> {
  const values = advanced ?? {}
  return {
    ignoreRequirements: values.ignoreRequirements,
    loopTimes: values.loopTimes,
    useSanityPotion: values.useSanityPotion,
    addTrust: values.addTrust,
    formationIndex: values.formationIndex,
    supportUsage: values.supportUsage,
    supportName: values.supportName,
    formationMode,
  }
}

/** 页面的 app/cli 都对应服务端连续执行；manual 保留逐关等待。 */
export function toCopilotSetRunMode(mode: CopilotSetExecutionMode): CopilotSetRunMode {
  return mode === 'manual' ? 'manual' : 'continuous'
}

/** 执行前校验；返回 null 表示可以提交。 */
export function validateCombatInput(taskId: string, input: string): string | null {
  if (taskId !== 'copilot' && taskId !== 'paradoxcopilot' && taskId !== 'ssscopilot') return null
  if (!input.trim()) return '请输入作业链接'
  if (taskId === 'ssscopilot' && splitCopilotInputToArgs(input).length !== 1) {
    return '保全派驻一次只能执行一个 SSS 作业 URI'
  }
  return null
}

export function raidFromAdvanced(advanced: AdvancedValues | undefined): CopilotRaid {
  return normalizeRaidValue(advanced?.raid)
}
