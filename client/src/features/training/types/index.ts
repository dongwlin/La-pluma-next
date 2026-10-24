/**
 * 干员养成域类型
 */

// 材料节点（层级结构）
export interface MaterialNode {
  id: string
  name: string
  iconId?: string
  count: number
  have: number
  needed: number
  stillNeeded: number
  children?: MaterialNode[]
}

// 干员训练信息
export interface TrainingOperator {
  id: string
  name: string
  rarity: number
  profession: string
  currentElite: number
  currentLevel?: number
  targetElite: number
  owned?: boolean
  hasMaterialData?: boolean
  canTrain?: boolean
  disabledReason?: 'unowned' | 'missing_material_data' | 'already_elite2' | null
  trainingStatus?: 'trainable' | 'unowned' | 'missing_material_data' | 'already_elite2'
  materials?: MaterialNode[]
  progress?: number
}

// 训练队列项
export interface TrainingQueueItem {
  operatorId: string
  operator: {
    name: string
    rarity: number
    profession: string
  }
  currentElite: number
  targetElite: number
  materials: MaterialNode[]
  lmd?: { needed: number; have: number; stillNeeded: number }
  progress: number
  isComplete?: boolean
  settings?: {
    useMedicine?: number
    useStone?: number
    autoSwitch?: boolean
    notifyOnComplete?: boolean
  }
}

// 训练设置
export interface TrainingSettings {
  useMedicine: number
  useStone: number
  autoSwitch: boolean
  notifyOnComplete: boolean
}

// 训练计划
export interface TrainingPlan {
  queueRevision?: string
  mode: 'current' | 'all'
  operators?: Array<{
    id: string
    name: string
    rarity: number
    currentElite: number
    targetElite: number
  }>
  focusOperator?: {
    id: string
    name: string
    rarity: number
  } | null
  materials?: Array<{
    id: string
    name: string
    count: number
  }>
  materialHierarchy?: MaterialNode[]
  stages?: Array<{
    stage: string
    stageName?: string
    totalTimes?: number
    sanityPerRun?: number
    isOpen?: boolean
    materials?: Array<{
      name: string
      needed?: number
      count?: number
    }>
  }>
  openStages?: Array<{
    stage: string
    totalTimes?: number
    isOpen?: boolean
    materials?: Array<{
      name: string
      needed?: number
      count?: number
    }>
  }>
  closedStages?: Array<{
    stage: string
    totalTimes?: number
    isOpen?: boolean
    materials?: Array<{
      name: string
      needed?: number
      count?: number
    }>
  }>
  totalSanity?: number
  estimatedTime?: string
  warnings?: string[]
  summary?: {
    totalStages?: number
    totalTimes?: number
    totalSanity?: number
    backlogCount?: number
    openStageCount?: number
    closedStageCount?: number
  }
}

// 筛选条件
export interface TrainingFilters {
  rarity: string
  needsElite2: boolean
  status: 'trainable' | 'owned' | 'all'
}

// 计划模式
export type TrainingPlanMode = 'current' | 'all'

// 材料层级节点组件 Props
export interface MaterialHierarchyNodeProps {
  node: MaterialNode
  depth?: number
}
