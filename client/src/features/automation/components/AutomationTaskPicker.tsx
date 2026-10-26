/**
 * 自动化任务挑选面板
 *
 * 菜单开关、点击外部关闭、Escape 关闭并回焦触发器都是本面板的局部交互状态；
 * 可添加任务目录来自 `automationTaskCatalog`。面板不写配置草稿：选中后通过
 * `onAddTask` 交给页面的唯一配置 owner。
 */

import { useEffect, useRef, useState, type RefObject } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Plus } from 'lucide-react'
import type { AutomationAvailableTask, TaskFlowItem } from '../types'
import { AVAILABLE_TASKS } from './automationTaskCatalog'

interface AutomationTaskPickerProps {
  flow: readonly TaskFlowItem[]
  disabled: boolean
  onAddTask: (task: AutomationAvailableTask) => void
  /** 页面把整条流程页脚传入：区域内按下指针不关闭菜单，保持原关闭区域。 */
  regionRef: RefObject<HTMLDivElement | null>
}

export default function AutomationTaskPicker({
  flow,
  disabled,
  onAddTask,
  regionRef,
}: AutomationTaskPickerProps) {
  const shouldReduceMotion = useReducedMotion()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // 运行态不能编辑：在渲染期收敛为关闭，避免 Effect 内级联 setState。
  if (disabled && open) setOpen(false)
  const isOpen = open && !disabled

  useEffect(() => {
    if (!isOpen) return

    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!regionRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }

    document.addEventListener('pointerdown', closeOnOutsidePress)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [isOpen, regionRef])

  const selectTask = (task: AutomationAvailableTask) => {
    onAddTask(task)
    setOpen(false)
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`automation-task-picker-toggle${isOpen ? ' is-open' : ''}`}
        onClick={() => setOpen(current => !current)}
        disabled={disabled}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-controls="automation-task-picker"
      >
        <Plus size={16} strokeWidth={2.1} />
        <span>添加任务</span>
        <small>{AVAILABLE_TASKS.length}</small>
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            id="automation-task-picker"
            role="menu"
            aria-label="可添加任务"
            className="automation-task-picker"
            initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: shouldReduceMotion ? 0.12 : 0.32, ease: [0.32, 0.72, 0, 1] }}
          >
            {AVAILABLE_TASKS.map(task => {
              const addedCount = flow.filter(flowTask => flowTask.commandId === task.id).length

              return (
                <button
                  key={task.id}
                  type="button"
                  role="menuitem"
                  onClick={() => selectTask(task)}
                  className="automation-task-picker-option"
                >
                  <span>{task.icon}</span>
                  <strong>{task.name}</strong>
                  {addedCount > 0 && <small>{addedCount}</small>}
                  <Plus size={14} strokeWidth={2} />
                </button>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
