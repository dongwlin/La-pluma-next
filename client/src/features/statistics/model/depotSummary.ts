/**
 * 仓库汇总纯模型
 *
 * 分类标签、分类分组、库存总量与「库存最多」都在这里计算；仓库面板只渲染结果。
 * 分组顺序沿用迁移前的稳定排序：按库存件数降序，件数相同保留物品首次出现的顺序。
 */

import type { DepotDataDetailed, DepotItem } from '@/features/game-data'

export const DEPOT_TYPE_LABELS: Readonly<Record<string, string>> = {
  MATERIAL: '材料',
  CARD_EXP: '经验书',
  ACTIVITY_ITEM: '活动道具',
  CONSUME: '消耗品',
  CHARM: '养成凭证',
  DIAMOND: '源石/至纯源石',
  EXP_ITEM: '经验材料',
  FURN: '家具',
  FURN_PART: '家具零件',
  HGG_SHD: '黄票/凭证',
  LGG_SHD: '绿票/凭证',
  RECRUIT_TAG: '公招相关',
  TKT: '票券',
}

export function getDepotTypeLabel(classifyType?: string): string {
  if (!classifyType) return '未分类'
  return DEPOT_TYPE_LABELS[classifyType] || '其他'
}

export interface DepotTypeGroup {
  type: string
  label: string
  /** 该分类下的物品种类数。 */
  kinds: number
  /** 该分类下的库存总件数。 */
  count: number
}

export interface DepotOverview {
  groups: DepotTypeGroup[]
  /** 服务端快照给出的物品种类数，不是本地去重后的条数。 */
  itemCount: number
  materialKinds: number
  categoryCount: number
  totalCount: number
  /** 库存件数最多的物品；并列时保留先出现的物品。 */
  topItem: DepotItem | null
}

/** 按分类聚合物品：件数求和、种类计数，并按件数降序返回。 */
export function summarizeDepotTypes(items: readonly DepotItem[]): DepotTypeGroup[] {
  const grouped = new Map<string, { count: number; kinds: number }>()
  for (const item of items) {
    const key = item.classifyType || 'UNKNOWN'
    const prev = grouped.get(key) ?? { count: 0, kinds: 0 }
    grouped.set(key, { count: prev.count + item.count, kinds: prev.kinds + 1 })
  }

  return Array.from(grouped, ([type, value]) => ({
    type,
    ...value,
    label: getDepotTypeLabel(type),
  })).sort((a, b) => b.count - a.count)
}

/** 仓库快照的页面概览；空快照返回全零，不抛错。 */
export function summarizeDepot(depot: DepotDataDetailed | null): DepotOverview {
  const items = depot?.items ?? []
  const groups = summarizeDepotTypes(items)
  let topItem: DepotItem | null = null
  for (const item of items) {
    if (!topItem || item.count > topItem.count) topItem = item
  }

  return {
    groups,
    itemCount: depot?.itemCount ?? 0,
    materialKinds: items.filter(item => item.classifyType === 'MATERIAL').length,
    categoryCount: groups.length,
    totalCount: items.reduce((sum, item) => sum + item.count, 0),
    topItem,
  }
}
