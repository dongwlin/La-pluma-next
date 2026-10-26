/**
 * 作业集选段纯模型
 *
 * 页面与配置中的 `copilotSetSelections` 都用有序整数数组表示“待执行”索引。
 * 这里集中处理去重、排序、与 Run 成功项求差，以及按服务端计划进度恢复选择：
 *
 * - 服务端计划是“已完成”的唯一来源；成功条目从待执行中移除，失败与未开始保留。
 * - 预设编队作业只要求普通模式；突袭/两者模式按作业支持的模式逐项判断。
 * - 已保存的本地选择与计划求交，避免把已完成关卡重新排入待执行。
 */

import type { CopilotRaid, CopilotSetItem } from '../types'

/** 去重、丢弃非整数并升序，作为选择写入配置与执行请求的唯一形状。 */
export function serializeCopilotSelection(indexes: Iterable<number>): number[] {
  return [...new Set(indexes)].filter(Number.isInteger).sort((left, right) => left - right)
}

/** 页面当前选择投影到作业集列表；越界索引不会进入执行请求。 */
export function selectedCopilotItemIndexes(
  selection: ReadonlySet<number>,
  itemCount: number,
): number[] {
  if (itemCount <= 0) return []
  return serializeCopilotSelection(
    [...selection].filter(index => index >= 0 && index < itemCount),
  )
}

/** “待执行”= 页面选择减去本次 Run 已成功的条目。 */
export function pendingCopilotItemIndexes(
  selected: Iterable<number>,
  successIndexes: ReadonlySet<number>,
): number[] {
  return serializeCopilotSelection([...selected].filter(index => !successIndexes.has(index)))
}

function requiredModesForItem(copilot: CopilotSetItem, raid: CopilotRaid): Array<'normal' | 'raid'> {
  if (copilot.presetFormation) return ['normal']
  if (raid === 'both') return ['normal', 'raid']
  return [raid === 'raid' ? 'raid' : 'normal']
}

/** 按计划进度计算仍待执行的作业索引；已完成项不进入列表。 */
export function pendingCopilotPlanIndexes(
  copilots: readonly CopilotSetItem[],
  raid: CopilotRaid,
): number[] {
  const pending: number[] = []
  copilots.forEach((copilot, index) => {
    const completedModes = copilot.completedModes ?? []
    const pendingItem = requiredModesForItem(copilot, raid)
      .some(mode => !completedModes.includes(mode))
    if (pendingItem) pending.push(index)
  })
  return pending
}

/**
 * 恢复作业集选择：没有保存过选择时使用全部待执行项；保存过则与待执行项
 * 求交（显式空数组保持空选择）。结果始终有序，供配置与执行共用。
 */
export function restorableCopilotIndexes(
  copilots: readonly CopilotSetItem[],
  raid: CopilotRaid,
  savedIndexes: readonly number[] | undefined,
): number[] {
  const pending = pendingCopilotPlanIndexes(copilots, raid)
  if (!Array.isArray(savedIndexes)) return pending
  const pendingSet = new Set(pending)
  return serializeCopilotSelection(savedIndexes.filter(index => pendingSet.has(index)))
}

export function toggleCopilotSelection(
  selection: ReadonlySet<number>,
  index: number,
): Set<number> {
  const next = new Set(selection)
  if (next.has(index)) next.delete(index)
  else next.add(index)
  return next
}

/** 全选与清空共用：当前已全选时清空，否则选中全部。 */
export function toggleAllCopilotSelection(
  selection: ReadonlySet<number>,
  itemCount: number,
): Set<number> {
  if (itemCount <= 0) return new Set()
  if (selection.size === itemCount) return new Set()
  return new Set(Array.from({ length: itemCount }, (_, index) => index))
}
