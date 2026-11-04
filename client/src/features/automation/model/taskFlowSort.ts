export const POINTER_SORT_ACTIVATION_PX = 10

export const hasPointerSortActivated = (
  startX: number,
  startY: number,
  clientX: number,
  clientY: number,
) => Math.hypot(clientX - startX, clientY - startY) >= POINTER_SORT_ACTIVATION_PX

/**
 * 把当前指针位置换算成“移除被拖拽项后的插入槽位”。
 *
 * 只比较其余任务的中线：指针在某个中线之上就插入到该项之前，否则落到末尾。
 * 无法读取中线的任务会被跳过，不影响其余项的相对顺序。被拖拽项不在流程中时返回 -1。
 */
export function getPointerSortTargetIndex<T extends { id: string }>(
  flow: readonly T[],
  itemId: string,
  clientY: number,
  getItemMidpoint: (taskId: string) => number | null,
): number {
  const currentIndex = flow.findIndex(task => task.id === itemId)
  if (currentIndex < 0) return -1

  const remainingTasks = flow.filter(task => task.id !== itemId)
  let insertionIndex = remainingTasks.length
  for (let index = 0; index < remainingTasks.length; index += 1) {
    const task = remainingTasks[index]
    if (!task) continue
    const midpoint = getItemMidpoint(task.id)
    if (midpoint !== null && clientY < midpoint) {
      insertionIndex = index
      break
    }
  }
  return insertionIndex
}

/**
 * 返回重排后的新数组；同位置、越界或缺失源项时原样返回输入引用。
 *
 * 索引语义与 `Array#splice` 一致：先把源项移出，再插入到目标槽位。因此向下移动时
 * 目标索引是“移除后”的位置，与 `getPointerSortTargetIndex` 的输出可直接配合。
 */
export const moveTaskFlowItem = <T extends { id: string },>(
  flow: T[],
  fromIndex: number,
  toIndex: number,
): T[] => {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= flow.length || toIndex >= flow.length) return flow
  const nextFlow = [...flow]
  const [movedTask] = nextFlow.splice(fromIndex, 1)
  if (!movedTask) return flow
  nextFlow.splice(toIndex, 0, movedTask)
  return nextFlow
}

/**
 * 关闭游戏步骤始终排在流程最后，其余任务保持原顺序。
 *
 * `commandId` 缺失时回退到 id 前缀，兼容旧本地草稿中只在 id 上带命令的条目。
 */
export function placeClosedownLast<T extends { id: string; commandId?: string }>(tasks: T[]): T[] {
  return [
    ...tasks.filter(task => task.commandId !== 'closedown' && !task.id.startsWith('closedown-')),
    ...tasks.filter(task => task.commandId === 'closedown' || task.id.startsWith('closedown-')),
  ]
}
