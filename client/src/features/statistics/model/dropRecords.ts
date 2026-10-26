/**
 * 掉落记录排序纯模型
 *
 * 面板只渲染排序结果：材料按掉落数量降序，关卡按战斗次数降序；
 * 数量相同时保留服务端对象键的原有顺序（Array.prototype.sort 稳定）。
 */

import type { DropStatistics } from '../types'

/** 材料卡片最多展示的种类数；超出部分只提示总数。 */
export const DROP_ITEM_DISPLAY_LIMIT = 20

export interface DropItemEntry {
  name: string
  count: number
  iconId?: string
}

export interface DropStageEntry {
  name: string
  battles: number
  sanity: number
  items: Record<string, number>
}

export function sortDropItems(items: DropStatistics['items']): DropItemEntry[] {
  return Object.entries(items)
    .map(([name, item]) => ({ name, count: item.count, iconId: item.iconId }))
    .sort((a, b) => b.count - a.count)
}

export function sortDropStages(stages: DropStatistics['stages']): DropStageEntry[] {
  return Object.entries(stages)
    .map(([name, stage]) => ({
      name,
      battles: stage.battles,
      sanity: stage.sanity,
      items: stage.items,
    }))
    .sort((a, b) => b.battles - a.battles)
}
