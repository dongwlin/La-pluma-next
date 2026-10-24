/**
 * 自动任务域类型
 */

import type { ReactNode } from 'react'

export type TaskCommandId = 'startup' | 'fight' | 'infrast' | 'recruit' | 'mall' | 'award' | 'closedown'

export type TaskParamFieldType =
  | 'text'
  | 'number'
  | 'select'
  | 'checkbox'
  | 'multi-stages'
  | 'stage-with-times'
  | 'star-select'
  | 'facility-select'

export interface TaskParamField {
  key: string
  label: string
  type: TaskParamFieldType
  placeholder?: string
  helper?: string
  options?: Array<{ value: string; label: string }> | string[]
  step?: string
  min?: string
  max?: string
  timesPlaceholder?: string
  visibleWhen?: { key: string; value: string | number | boolean }
  hiddenWhen?: { key: string; value: string | number | boolean }
}

export interface StageConfig {
  stage: string
  times?: string
  pinned?: boolean
  smart?: boolean
  trainingOperators?: string[]
}

export interface TaskParams {
  // 启动游戏
  clientType?: string
  adbPath?: string
  address?: string
  accountName?: string
  recognizeDepotBeforeClose?: boolean

  // 理智作战
  stage?: string
  stages?: Array<string | StageConfig>
  medicine?: number | string
  expiringMedicine?: number | string
  stone?: number | string
  series?: number | string
  times?: string
  drops?: string | Record<string, number | string>
  DrGrandet?: boolean
  report_to_penguin?: boolean
  penguin_id?: string
  report_to_yituliu?: boolean
  yituliu_id?: string

  // 基建
  mode?: string
  facility?: string[]
  drones?: string
  threshold?: string
  replenish?: boolean
  filename?: string
  plan_index?: number | string
  continue_training?: boolean
  dorm_notstationed_enabled?: boolean
  dorm_trust_enabled?: boolean
  reception_message_board?: boolean
  reception_clue_exchange?: boolean
  reception_send_clue?: boolean

  // 公招
  refresh?: boolean
  force_refresh?: boolean
  select?: number[]
  confirm?: number[]
  first_tags?: string | string[]
  extra_tags_mode?: number | string
  set_time?: boolean
  expedite?: boolean
  expedite_times?: number
  preserve_tags?: string | string[]
  recruitment_time?: Record<string, number | string>
  /** @deprecated Migrated to preserve_tags when loading saved tasks. */
  skip_robot?: boolean

  // 信用收支
  visit_friends?: boolean
  shopping?: boolean
  buy_first?: string
  blacklist?: string
  force_shopping_if_credit_full?: boolean
  only_buy_discount?: boolean
  reserve_max_credit?: boolean
  credit_fight?: boolean
  formation_index?: number | string

  // 领取奖励
  award?: boolean
  mail?: boolean
  recruit?: boolean
  orundum?: boolean
  mining?: boolean
  specialaccess?: boolean

  // 其他
  [key: string]: any
}

export interface AutomationAvailableTask {
  id: TaskCommandId
  name: string
  icon: ReactNode
  description: string
  defaultParams: TaskParams
  paramFields: TaskParamField[]
  taskType?: string
}

export interface TaskFlowItem {
  // 从 AutomationAvailableTask 继承的属性
  name: string
  icon: ReactNode
  description: string
  defaultParams: TaskParams
  paramFields: TaskParamField[]
  taskType?: string

  // TaskFlowItem 特有的属性
  id: string // 唯一标识符（如 "startup-1234567890"）
  commandId: TaskCommandId // 任务命令 ID
  params: TaskParams
  enabled: boolean
}

export interface ConnectionTestStatus {
  success: boolean
  message: string
}
