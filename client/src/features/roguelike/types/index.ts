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
  /**
   * 声明后，缺失或空字符串在显示、草稿归一化与命令构造三处都解析为该值，
   * 并始终显式写入命令参数。未声明时保持“未设置即省略”的行为。
   */
  defaultValue?: string
  /** 字段下方的说明文案；由面板透传，语义留在模型。 */
  hint?: string
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
