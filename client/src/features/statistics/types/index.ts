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

export type ActiveTask = 'depot' | 'operbox' | null
export type ActiveTab = 'operbox' | 'depot' | 'drops'
export type OpenMenu = 'ownership' | 'rarity' | 'profession' | 'elite' | 'potential' | 'sort' | null
