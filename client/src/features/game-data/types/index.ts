export interface OperatorNames {
  en?: string
  jp?: string
  kr?: string
  tw?: string
}

/** 识别目录条目：MAA `all_opers` 的持久化形态，带拥有标记与可选多语言名称。 */
export interface OperBoxCatalogOperator {
  id: string
  name: string
  names?: OperatorNames
  rarity?: number
  owned: boolean
}

/** 识别快照的完整度：只有带识别目录的快照能确认未拥有状态。 */
export interface OperBoxRecognitionInfo {
  status: 'complete' | 'partial'
  total: number
  owned: number
}

export interface DepotItem {
  id: string
  name: string
  iconId: string
  count: number
  classifyType: string
}

export interface DepotDataDetailed {
  itemCount: number
  items: DepotItem[]
  path?: string
  timestamp: string
}

export interface OperatorDetailed {
  id: string
  name: string
  rarity: number
  profession: string
  position?: string
  level: number
  elite: number
  potential: number
  currentElite?: number
  hasMaterialData?: boolean
}

export interface OperBoxData {
  operCount: number
  data: OperatorDetailed[]
  allOpers?: OperBoxCatalogOperator[]
  operTotal?: number
  recognition?: OperBoxRecognitionInfo
  path?: string
  timestamp: string
}
