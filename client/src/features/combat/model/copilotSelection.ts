import { isRecord } from '@/shared/api/validation'
import type { CopilotDifficulty, CopilotRaid, CopilotSetItem } from '../types'

export function readCopilotRecommendedMode(value: unknown): CopilotDifficulty | undefined {
  return value === 'normal' || value === 'raid' || value === 'both' ? value : undefined
}

/**
 * 预设编队作业：没有固定干员与干员组，且关卡以 `_s<数字>` 结尾。
 * 与服务端 `isPresetFormationCopilot` 同一规则，供本地文件与远端单作业共用。
 */
export function isPresetFormationContent(content: unknown): boolean {
  if (!isRecord(content)) return false
  const stageName = typeof content.stage_name === 'string' ? content.stage_name : ''
  return (!Array.isArray(content.opers) || content.opers.length === 0)
    && (!Array.isArray(content.groups) || content.groups.length === 0)
    && /_s\d+$/i.test(stageName)
}

export function copilotDifficultyFromFlags(value: unknown): CopilotDifficulty | undefined {
  if (value === 0 || value === 1) return 'normal'
  if (value === 2) return 'raid'
  if (value === 3) return 'both'
  return undefined
}

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

/** “待执行”= 页面选择减去已满足完成条件的作业索引。 */
export function pendingCopilotItemIndexes(
  selected: Iterable<number>,
  completedIndexes: ReadonlySet<number>,
): number[] {
  return serializeCopilotSelection([...selected].filter(index => !completedIndexes.has(index)))
}

/** 当前 raid 规则下作业必须完成的模式；预设编队作业只要求普通模式。 */
export function requiredCopilotItemModes(
  copilot: CopilotSetItem,
  raid: CopilotRaid,
): Array<'normal' | 'raid'> {
  if (copilot.presetFormation) return ['normal']
  const mode = raid === 'auto' ? copilot.recommendedMode : raid
  if (mode === 'both') return ['normal', 'raid']
  return [mode === 'raid' ? 'raid' : 'normal']
}

/** 按计划进度计算仍待执行的作业索引；已完成项不进入列表。 */
export function pendingCopilotPlanIndexes(
  copilots: readonly CopilotSetItem[],
  raid: CopilotRaid,
): number[] {
  const pending: number[] = []
  copilots.forEach((copilot, index) => {
    const completedModes = copilot.completedModes ?? []
    const pendingItem = requiredCopilotItemModes(copilot, raid)
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

export function toggleAllCopilotSelection(
  selection: ReadonlySet<number>,
  itemCount: number,
): Set<number> {
  if (itemCount <= 0) return new Set()
  if (selection.size === itemCount) return new Set()
  return new Set(Array.from({ length: itemCount }, (_, index) => index))
}
