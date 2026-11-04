export interface DropTarget {
  itemId: string
  count: number
}

const DROP_TARGET_ENTRY_PATTERN = /^([A-Za-z0-9_-]+)\s*=\s*(\d+)$/

function rawDropTargetEntries(value: unknown): string[] {
  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>)
      .map(([itemId, count]) => `${itemId}=${count}`)
  }
  return String(value).split(',').map(entry => entry.trim()).filter(Boolean)
}

/** 解析掉落目标；非法输入返回 null，空输入返回空数组。 */
export function parseDropTargets(value: unknown): DropTarget[] | null {
  if (value === undefined || value === null || value === '') return []

  const targets: DropTarget[] = []
  for (const entry of rawDropTargetEntries(value)) {
    const match = entry.match(DROP_TARGET_ENTRY_PATTERN)
    if (!match || Number(match[2]) <= 0) return null
    targets.push({ itemId: match[1]!, count: Number(match[2]) })
  }
  return targets
}

/** 规范化输出；与 `parseDropTargets` 互为逆变换（对象形状输入按解析后的顺序输出）。 */
export function formatDropTargets(targets: readonly DropTarget[]): string {
  return targets.map(target => `${target.itemId}=${target.count}`).join(',')
}
