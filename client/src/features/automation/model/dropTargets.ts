/**
 * 掉落目标参数纯模型
 *
 * `fight.params.drops` 接受两种历史形状：逗号分隔的 `物品ID=数量` 文本，
 * 以及旧版保存的对象 `{ [itemId]: count }`。模型统一解析为结构化目标：
 * - 空值（`undefined`/`null`/空字符串）表示“未设置目标”，解析为空数组；
 * - 物品 ID 只允许字母、数字、下划线与连字符，数量必须为正整数；
 * - 任一条目非法时整份输入解析失败（返回 null），与迁移前执行前校验一致；
 * - 规范化输出使用逗号分隔、无空格的 `物品ID=数量`，可再次解析。
 *
 * 模型不访问 React、网络或存储；页面只把当前参数值交给校验。
 */

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
