/**
 * 自动化流程排序接线
 *
 * 指针排序的预览、键盘移动与 Escape 取消都集中在这里，排序规则仍由
 * `model/taskFlowSort.ts` 提供。拖拽期间只渲染本地预览，松手时才把最终顺序
 * 作为一次编辑交给配置 owner。
 *
 * 指针生命周期：浏览器在流程重新排序后可能释放 pointer capture（性能基线
 * 已记录该现象）。排序必须继续跟随指针，因此移动/抬起/取消事件挂在
 * `document` 上，`lostpointercapture` 不再等同于取消；只有 Escape、显式
 * pointercancel 或组件被 Activity 隐藏/卸载才恢复原顺序。capture 仍会尝试
 * 建立，用于指针离开手柄时的浏览器语义，但排序不依赖它。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TaskFlowItem } from '../types'
import {
  getPointerSortTargetIndex,
  hasPointerSortActivated,
  moveTaskFlowItem,
} from '../model/taskFlowSort'

interface PointerSortSession {
  pointerId: number
  startX: number
  startY: number
  itemId: string
  currentFlow: TaskFlowItem[]
  activated: boolean
  changed: boolean
}

interface UseTaskFlowSortingOptions {
  /** 当前已提交的流程；拖拽预览基于它的副本。 */
  flow: TaskFlowItem[]
  disabled: boolean
  /** 松手或键盘移动后交给配置 owner；参数是显示顺序，含图标/参数字段。 */
  onCommit: (flow: TaskFlowItem[]) => void
}

export interface TaskFlowSorting {
  displayedFlow: TaskFlowItem[]
  draggedIndex: number | null
  announcement: string
  registerItem: (taskId: string, node: HTMLDivElement | null) => void
  handlePointerDown: (event: React.PointerEvent<HTMLButtonElement>, taskId: string) => void
  handleKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, taskId: string) => void
}

export function useTaskFlowSorting({
  flow,
  disabled,
  onCommit,
}: UseTaskFlowSortingOptions): TaskFlowSorting {
  const [dragFlow, setDragFlow] = useState<TaskFlowItem[] | null>(null)
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const pointerSortRef = useRef<PointerSortSession | null>(null)
  const sequenceItemRefs = useRef(new Map<string, HTMLDivElement>())
  // 事件监听只安装一次；每次渲染后把最新输入写进 ref，避免重新订阅。
  const flowRef = useRef(flow)
  const disabledRef = useRef(disabled)
  const commitRef = useRef(onCommit)
  useEffect(() => {
    flowRef.current = flow
    disabledRef.current = disabled
    commitRef.current = onCommit
  }, [disabled, flow, onCommit])

  const registerItem = useCallback((taskId: string, node: HTMLDivElement | null) => {
    if (node) sequenceItemRefs.current.set(taskId, node)
    else sequenceItemRefs.current.delete(taskId)
  }, [])

  const cancelSorting = useCallback(() => {
    const session = pointerSortRef.current
    if (!session) return
    pointerSortRef.current = null
    setDraggedIndex(null)
    setDragFlow(null)
    if (session.changed) setAnnouncement('已取消排序')
  }, [])

  const handlePointerDown = useCallback((
    event: React.PointerEvent<HTMLButtonElement>,
    taskId: string,
  ) => {
    if (disabledRef.current || event.button !== 0 || pointerSortRef.current) return
    pointerSortRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      itemId: taskId,
      currentFlow: [...flowRef.current],
      activated: false,
      changed: false,
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Capture can fail if the pointer already ended.
    }
  }, [])

  const handleKeyDown = useCallback((
    event: React.KeyboardEvent<HTMLButtonElement>,
    taskId: string,
  ) => {
    if (disabledRef.current || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    const currentFlow = flowRef.current
    const currentIndex = currentFlow.findIndex(task => task.id === taskId)
    if (currentIndex < 0) return
    const targetIndex = event.key === 'ArrowUp' ? currentIndex - 1 : currentIndex + 1
    const newFlow = moveTaskFlowItem(currentFlow, currentIndex, targetIndex)
    if (newFlow === currentFlow) return
    commitRef.current(newFlow)
    setAnnouncement(`${newFlow[targetIndex]?.name || '任务'}已移动到第 ${targetIndex + 1} 位`)
  }, [])

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const session = pointerSortRef.current
      if (!session || session.pointerId !== event.pointerId) return
      // 运行态不能排序：执行开始后取消尚未结束的预览。
      if (disabledRef.current) {
        cancelSorting()
        return
      }

      if (!session.activated) {
        if (!hasPointerSortActivated(session.startX, session.startY, event.clientX, event.clientY)) return
        session.activated = true
      }

      const currentFlow = session.currentFlow
      const currentIndex = currentFlow.findIndex(task => task.id === session.itemId)
      if (currentIndex < 0) return
      setDraggedIndex(currentIndex)

      const targetIndex = getPointerSortTargetIndex(currentFlow, session.itemId, event.clientY, taskId => {
        const rect = sequenceItemRefs.current.get(taskId)?.getBoundingClientRect()
        return rect ? rect.top + rect.height / 2 : null
      })
      if (targetIndex === currentIndex) return

      const newFlow = moveTaskFlowItem(currentFlow, currentIndex, targetIndex)
      session.currentFlow = newFlow
      session.changed = true
      setDragFlow(newFlow)
      setDraggedIndex(targetIndex)
    }

    const handlePointerUp = (event: PointerEvent) => {
      const session = pointerSortRef.current
      if (!session || session.pointerId !== event.pointerId) return
      if (disabledRef.current) {
        cancelSorting()
        return
      }
      pointerSortRef.current = null
      setDraggedIndex(null)
      setDragFlow(null)
      if (!session.activated || !session.changed) return

      const committedFlow = session.currentFlow
      const committedIndex = committedFlow.findIndex(task => task.id === session.itemId)
      commitRef.current(committedFlow)
      setAnnouncement(`${committedFlow[committedIndex]?.name || '任务'}已移动到第 ${committedIndex + 1} 位`)
    }

    const handlePointerCancel = (event: PointerEvent) => {
      const session = pointerSortRef.current
      if (!session || session.pointerId !== event.pointerId) return
      cancelSorting()
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !pointerSortRef.current) return
      event.preventDefault()
      cancelSorting()
    }

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)
    document.addEventListener('pointercancel', handlePointerCancel)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
      document.removeEventListener('pointercancel', handlePointerCancel)
      document.removeEventListener('keydown', handleEscape)
      // Activity 隐藏或真正卸载时丢弃进行中的排序，避免恢复后残留预览。
      if (pointerSortRef.current) {
        pointerSortRef.current = null
        setDraggedIndex(null)
        setDragFlow(null)
      }
    }
  }, [cancelSorting])

  return {
    displayedFlow: dragFlow ?? flow,
    draggedIndex,
    announcement,
    registerItem,
    handlePointerDown,
    handleKeyDown,
  }
}
