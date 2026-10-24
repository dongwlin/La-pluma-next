/**
 * 数据统计域类型
 */

export interface DropStatistics {
  total: {
    sanity: number
    battles: number
    medicine: number
    stone: number
  }
  items: {
    [itemName: string]: {
      count: number
      iconId?: string
    }
  }
  stages: {
    [stageName: string]: {
      battles: number
      sanity: number
      items: {
        [itemName: string]: number
      }
    }
  }
  dailyTrend?: any[]
  dateRange: {
    start: string
    end: string
    days: number
  }
}

export interface DropRecordsProps {
  dropStatistics: DropStatistics | null
  dropDays: number
  setDropDays: (days: number) => void
  onRefresh: () => void
}

// 仓库数据 (组件专用,包含详细的 items 数组)
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

// 干员数据 (组件专用,包含详细信息)
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

// 筛选状态
export type FilterRarity = 'all' | '1' | '2' | '3' | '4' | '5' | '6'
export type FilterElite = 'all' | '0' | '1' | '2'
export type FilterPotential = 'all' | '1' | '2' | '3' | '4' | '5' | '6'
export type FilterOwnership = 'all' | 'owned' | 'unowned'
export type FilterProfession = 'all' | 'PIONEER' | 'WARRIOR' | 'TANK' | 'SNIPER' | 'CASTER' | 'MEDIC' | 'SUPPORT' | 'SPECIAL'
export type SortBy = 'default' | 'level' | 'rarity' | 'potential'
export type ActiveTask = 'depot' | 'operbox' | null
export type ActiveTab = 'operbox' | 'depot' | 'drops'
export type OpenMenu = 'ownership' | 'rarity' | 'profession' | 'elite' | 'potential' | 'sort' | null
