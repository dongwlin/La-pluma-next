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

export type CopilotRaid = 'normal' | 'raid' | 'both'

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

export interface CopilotSetItem {
  id: number
  name?: string
  stage?: string
  stageId?: string
  operators?: string
  uri?: string
  presetFormation?: boolean
  supportsRaid?: boolean
  completedModes?: Array<'normal' | 'raid'>
}

export interface CopilotSetInfo {
  type: 'single' | 'set'
  id: string
  name: string
  stage?: string
  operators?: string
  note?: string
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
