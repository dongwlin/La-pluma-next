/**
 * 肉鸽任务域类型
 */

/** 两个模式各自有独立的主题目录与高级字段。 */
export type RoguelikeMode = 'roguelike' | 'reclamation'

export interface RoguelikeTask {
  id: RoguelikeMode
  name: string
  command: string
  placeholder: string
  icon: string
  hasAdvanced: boolean
  description: string
}

export interface RoguelikeAdvancedOption {
  key: string
  label: string
  type: 'text' | 'number' | 'select' | 'checkbox'
  param: string
  placeholder?: string
  options?: Array<{ value: string; label: string }>
}

export interface RoguelikeTaskInputs {
  [taskId: string]: string
}

export interface RoguelikeAdvancedValues {
  [key: string]: string | number | boolean
}

export interface RoguelikeAdvancedParams {
  [taskId: string]: RoguelikeAdvancedValues
}
