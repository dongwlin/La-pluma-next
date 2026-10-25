/**
 * 数据统计域类型
 * 仓库、持有干员与干员目录的载荷类型由 `features/game-data` 持有。
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
