/**
 * 肉鸽任务目录、选项与命令纯模型
 *
 * 页面与面板只提供当前草稿，模型不读取配置通道、执行控制器或任何 React 状态：
 *
 * - `ROGUELIKE_TASKS` 是模式选择器与配置表单共用的任务目录；
 * - `ROGUELIKE_THEME_PRESETS` 只描述界面上可点的主题快捷项，服务端载荷仍以
 *   `taskInputs` 里的主题代号为准；
 * - 高级参数表按任务定义 CLI 参数名，选项顺序决定命令追加顺序；
 * - 输入校验只要求两个已知模式有非空主题，与迁移前页面一致。
 */

import type {
  RoguelikeAdvancedOption,
  RoguelikeAdvancedParams,
  RoguelikeAdvancedValues,
  RoguelikeMode,
  RoguelikeTask,
  RoguelikeTaskInputs,
} from '../types'

export const DEFAULT_ROGUELIKE_MODE: RoguelikeMode = 'roguelike'

/**
 * 生息演算默认模式与 CLI 一致：`-m` 缺省为 1（有存档时制作工具）。
 * 模式 0 仅在没有存档时使用，已有存档时可能丢失进度。
 */
export const DEFAULT_RECLAMATION_MODE = '1'

const RECLAMATION_MODE_HINT = '模式 0 仅在没有存档时使用（有存档可能丢失进度），需在主界面右下角出现「开始演算」后启动；模式 1 需要已有存档，需在能看到驻扎地的页面启动，建议从新的计算日开始。'

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

const ADVANCED_OPTIONS: Record<string, RoguelikeAdvancedOption[]> = {
  roguelike: [
    { key: 'mode', label: '模式', type: 'select', param: '--mode', options: [
      { value: '0', label: '刷分模式' },
      { value: '1', label: '刷源石锭' },
      { value: '4', label: '刷开局' },
    ]},
    { key: 'squad', label: '起始分队', type: 'text', param: '--squad', placeholder: '指挥分队' },
    { key: 'coreChar', label: '核心干员', type: 'text', param: '--core-char', placeholder: '维什戴尔' },
    { key: 'startCount', label: '运行次数', type: 'number', param: '--start-count', placeholder: '无限' },
    { key: 'useSupport', label: '使用助战', type: 'checkbox', param: '--use-support' },
    { key: 'stopAtBoss', label: '最终Boss前停止', type: 'checkbox', param: '--stop-at-final-boss' },
  ],
  reclamation: [
    {
      key: 'mode',
      label: '模式',
      type: 'select',
      param: '-m',
      options: [
        { value: '0', label: '刷繁荣度（无存档）' },
        { value: '1', label: '制作工具刷繁荣度' },
      ],
      defaultValue: DEFAULT_RECLAMATION_MODE,
      hint: RECLAMATION_MODE_HINT,
    },
    { key: 'toolsToCraft', label: '制作工具名称', type: 'text', param: '-C', placeholder: '荧光棒' },
    { key: 'numBatches', label: '批次数', type: 'number', param: '--num-craft-batches', placeholder: '16' },
  ],
}

export function getRoguelikeAdvancedOptions(taskId: string): RoguelikeAdvancedOption[] {
  return ADVANCED_OPTIONS[taskId] ?? []
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
 * 字段的显示值：先按默认值解析，再回落到 select 的首项。
 * 命令构造不使用首项回落——未声明默认值的字段保持省略。
 */
export function resolveRoguelikeAdvancedValue(
  option: RoguelikeAdvancedOption,
  advanced: RoguelikeAdvancedValues,
): string | number | boolean | undefined {
  return pickAdvancedValue(option, advanced) ?? option.options?.[0]?.value
}

/**
 * 补齐声明了默认值但缺失或为空的字段。返回新对象，且只在确有补齐时复制；
 * 不修改入参，无变化时返回原引用以便草稿等价判断保持稳定。
 */
export function normalizeRoguelikeAdvancedParams(
  advancedParams: RoguelikeAdvancedParams,
): RoguelikeAdvancedParams {
  let normalized: RoguelikeAdvancedParams | null = null

  for (const taskId of Object.keys(ADVANCED_OPTIONS)) {
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
 * 拼接执行参数：主题代号在前，高级选项按选项表顺序追加。
 * 空字符串、未勾选的 checkbox 与未设置的字段不写入命令；声明了默认值的字段
 * 在缺失或为空时解析为默认值并始终写入。
 */
export function buildRoguelikeCommandParams(
  taskId: string,
  taskInputs: RoguelikeTaskInputs,
  advancedParams: RoguelikeAdvancedParams,
): string {
  let params = taskInputs[taskId] || ''
  const advanced = advancedParams[taskId] || {}

  for (const option of getRoguelikeAdvancedOptions(taskId)) {
    const value = pickAdvancedValue(option, advanced)
    if (value === undefined || value === '' || value === false) continue

    if (option.type === 'checkbox' && value === true) {
      params += ` ${option.param}`
    } else if (option.type !== 'checkbox') {
      params += ` ${option.param} ${value}`
    }
  }

  return params
}

/** 执行前校验；返回 null 表示可以提交。 */
export function validateRoguelikeTaskInput(
  taskId: string,
  taskInputs: RoguelikeTaskInputs,
): string | null {
  if (taskId !== 'roguelike' && taskId !== 'reclamation') return null
  return (taskInputs[taskId] || '').trim() ? null : '请输入主题名称'
}
