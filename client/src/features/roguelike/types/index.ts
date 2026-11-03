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

/** 下拉项：value 是写入命令的原始值，label 是界面文案。 */
export interface RoguelikeSelectOption {
  value: string
  label: string
}

/** 字段依赖：条件不满足时既不下发也不显示。 */
export interface RoguelikeOptionRequirement {
  key: string
  /** 需要依赖字段为 true，或等于给定值；省略时要求字段为真/非空。 */
  equals?: string | boolean
  /** 需要依赖字段取所列值之一；用于分队等存在多个合法取值的条件。 */
  oneOf?: readonly string[]
}

export type RoguelikeAdvancedOptionType = 'text' | 'number' | 'select' | 'checkbox' | 'list'

export interface RoguelikeAdvancedOption {
  key: string
  label: string
  type: RoguelikeAdvancedOptionType
  param: string
  placeholder?: string
  options?: RoguelikeSelectOption[]
  /** 取值随主题变化的选项表，优先于 `options`。 */
  choices?: 'modes' | 'difficulty' | 'squads' | 'roles'
  /**
   * 声明后，缺失或空字符串在显示、草稿归一化与命令构造三处都解析为该值，
   * 并始终显式写入命令参数。未声明时保持“未设置即省略”的行为。
   */
  defaultValue?: string
  /** 字段下方的说明文案；由面板透传，语义留在模型。 */
  hint?: string
  /** number 字段的闭区间；省略时按 CLI 的 i32 范围校验。 */
  numberRange?: { min: number; max: number }
  /** 仅在这些主题下显示与下发；省略表示所有主题。 */
  themes?: readonly string[]
  /** 仅在这些模式下显示与下发；省略表示所有模式。 */
  modes?: readonly string[]
  /** 依赖另一字段；条件不满足时既不下发也不显示。 */
  requires?: RoguelikeOptionRequirement
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
