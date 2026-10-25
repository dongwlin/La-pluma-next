/**
 * 战斗任务域类型
 */

import type { ReactNode } from 'react'

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

/** 每个作业集已保存的待执行索引。 */
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

// 作业集中的单个作业信息
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
  // 作业集包含的作业列表
  copilots?: CopilotSetItem[]
  // 当前执行到的作业索引（用于顺序执行）
  currentIndex?: number
}

export interface CopilotSearchResult {
  stage: string
  copilots: Array<{
    id: string
    uri: string
    views: number
    hotScore: number
    stageName?: string
    title?: string
  }>
  recommended?: {
    uri: string
  }
}

export interface ParadoxSearchResult {
  operator: string
  copilots: Array<{
    id: string
    uri: string
    views: number
    hotScore: number
    stageName?: string
    title?: string
  }>
  recommended?: {
    uri: string
  }
}
