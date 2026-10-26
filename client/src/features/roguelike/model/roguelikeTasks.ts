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
  RoguelikeMode,
  RoguelikeTask,
  RoguelikeTaskInputs,
} from '../types'

export const DEFAULT_ROGUELIKE_MODE: RoguelikeMode = 'roguelike'

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
      { value: '4', label: '3层后退出' },
    ]},
    { key: 'squad', label: '起始分队', type: 'text', param: '--squad', placeholder: '指挥分队' },
    { key: 'coreChar', label: '核心干员', type: 'text', param: '--core-char', placeholder: '维什戴尔' },
    { key: 'startCount', label: '运行次数', type: 'number', param: '--start-count', placeholder: '无限' },
    { key: 'useSupport', label: '使用助战', type: 'checkbox', param: '--use-support' },
    { key: 'stopAtBoss', label: '最终Boss前停止', type: 'checkbox', param: '--stop-at-final-boss' },
  ],
  reclamation: [
    { key: 'mode', label: '模式', type: 'select', param: '-m', options: [
      { value: '0', label: '刷繁荣度（无存档）' },
      { value: '1', label: '制作工具刷繁荣度' },
    ]},
    { key: 'toolsToCraft', label: '制作工具名称', type: 'text', param: '-C', placeholder: '荧光棒' },
    { key: 'numBatches', label: '批次数', type: 'number', param: '--num-craft-batches', placeholder: '16' },
  ],
}

export function getRoguelikeAdvancedOptions(taskId: string): RoguelikeAdvancedOption[] {
  return ADVANCED_OPTIONS[taskId] ?? []
}

/**
 * 拼接执行参数：主题代号在前，高级选项按选项表顺序追加。
 * 空字符串、未勾选的 checkbox 与未设置的字段不写入命令；这与迁移前页面一致。
 */
export function buildRoguelikeCommandParams(
  taskId: string,
  taskInputs: RoguelikeTaskInputs,
  advancedParams: RoguelikeAdvancedParams,
): string {
  let params = taskInputs[taskId] || ''
  const advanced = advancedParams[taskId] || {}

  for (const option of getRoguelikeAdvancedOptions(taskId)) {
    const value = advanced[option.key]
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
