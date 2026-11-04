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
  path?: string
  timestamp: string
}
