import type { ReactNode } from 'react'

/** 作业页的三种入口；模式切换不写入配置。 */
export type CombatMode = 'copilot' | 'ssscopilot' | 'paradoxcopilot'

export interface CombatTask {
  id: string
  name: string
  command: string
  placeholder: string
  icon: ReactNode
  hasAdvanced: boolean
  description: string
}

export interface CombatAdvancedOption {
  key: string
  label: string
  type: 'text' | 'number' | 'select' | 'checkbox'
  param: string
  placeholder?: string
  helper?: string
  options?: Array<{ value: string; label: string }>
}

export interface CombatTaskInputs {
  [taskId: string]: string
}

/** 作业集执行方式；`app` 是旧值，仅在加载时迁移为 `cli`。 */
export type CopilotSetExecutionMode = 'app' | 'manual' | 'cli'

export type CopilotDifficulty = 'normal' | 'raid' | 'both'

export type CopilotRaid = CopilotDifficulty | 'auto'

export type CopilotSetSelections = Record<string, number[]>

export interface CombatAdvancedParams {
  [taskId: string]: {
    [key: string]: string | number | boolean
  }
}

export type FormationMode = 'auto' | 'on' | 'off'

export interface AutoFormationConfig {
  [taskId: string]: boolean | FormationMode
}

export interface CopilotDetailOperator {
  name: string
  group?: string
  elite?: number | null
  level?: number | null
  skillLevel?: number | null
  module?: string | null
}

export interface CopilotSetItem {
  id: number
  name?: string
  stage?: string
  stageId?: string
  /** 关卡理智消耗；资源数据缺失时为 null。 */
  apCost?: number | null
  operators?: string
  operatorDetails?: CopilotDetailOperator[]
  groupNames?: string[]
  uri?: string
  presetFormation?: boolean
  supportsRaid?: boolean
  recommendedMode?: CopilotDifficulty
  completedModes?: Array<'normal' | 'raid'>
}

export interface CopilotSetInfo {
  type: 'single' | 'set'
  id: string
  name: string
  stage?: string
  operators?: string
  operatorDetails?: CopilotDetailOperator[]
  groupNames?: string[]
  note?: string
  recommendedMode?: CopilotDifficulty
  autoAddS?: boolean
  copilots?: CopilotSetItem[]
  currentIndex?: number
}

export interface CopilotSearchItem {
  id: string
  uri: string
  views: number
  hotScore: number
  stageName?: string
  title?: string
}

export interface CopilotSearchResult {
  stage: string
  copilots: CopilotSearchItem[]
  recommended?: {
    uri: string
  }
}

export interface ParadoxSearchResult {
  operator: string
  copilots: CopilotSearchItem[]
  recommended?: {
    uri: string
  }
}
