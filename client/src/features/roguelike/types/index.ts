/**
 * 肉鸽任务域类型
 */

export interface RoguelikeTask {
  id: string
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

export interface RoguelikeAdvancedParams {
  [taskId: string]: {
    [key: string]: string | number | boolean
  }
}
