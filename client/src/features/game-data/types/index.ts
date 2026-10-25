/**
 * 游戏数据资源共享类型
 * 仓库、持有干员与干员目录的载荷形状；页面筛选与展示状态仍归各页面域。
 */

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
