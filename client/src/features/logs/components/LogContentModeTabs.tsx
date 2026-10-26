/**
 * 摘要/原始内容模式分段控件
 *
 * 模式由工作区持有（过滤与导出共享同一份视图），本组件只负责受控分段、
 * 流体高亮与键盘导航。测量、ResizeObserver 与键盘规则跟随组件生命周期，
 * 不提升为页面状态。
 */

import { motion, useReducedMotion } from 'framer-motion'
import { FileText, List } from 'lucide-react'
import { useFluidTabIndicator } from '@/shared/hooks/useFluidTabIndicator'
import type { LogContentMode } from '../model/logModel'

const CONTENT_MODE_OPTIONS: ReadonlyArray<{ id: LogContentMode; label: string; description: string }> = [
  { id: 'summary', label: '摘要', description: '关键事件' },
  { id: 'raw', label: '原始', description: '完整内容' },
]

interface LogContentModeTabsProps {
  readonly mode: LogContentMode
  readonly onChange: (mode: LogContentMode) => void
}

export default function LogContentModeTabs({ mode, onChange }: LogContentModeTabsProps) {
  const shouldReduceMotion = useReducedMotion()
  const {
    containerRef,
    activeRect,
    setTabRef,
    handleTabKeyDown,
  } = useFluidTabIndicator(mode)

  return (
    <div className="app-workspace-segments app-liquid-tab-pill log-mode-shell">
      <div
        ref={containerRef}
        className="app-workspace-segment-list log-mode-tabs"
        role="tablist"
        aria-label="日志内容模式"
      >
        {activeRect.width > 0 && (
          <motion.div
            data-testid="log-mode-highlight"
            aria-hidden="true"
            className="app-workspace-segment-indicator log-mode-highlight"
            initial={false}
            animate={{
              x: activeRect.x,
              y: activeRect.y,
              width: activeRect.width,
              height: activeRect.height,
            }}
            transition={shouldReduceMotion
              ? { duration: 0 }
              : { type: 'spring', stiffness: 420, damping: 38, mass: 0.72 }}
          />
        )}
        {CONTENT_MODE_OPTIONS.map(option => {
          const selected = mode === option.id
          const ModeIcon = option.id === 'summary' ? List : FileText
          return (
            <button
              key={option.id}
              ref={setTabRef(option.id)}
              type="button"
              role="tab"
              onClick={() => onChange(option.id)}
              onKeyDown={event => handleTabKeyDown(
                event,
                CONTENT_MODE_OPTIONS.map(({ id }) => id),
                onChange,
              )}
              aria-selected={selected}
              aria-controls="log-console-panel"
              tabIndex={selected ? 0 : -1}
              className={`app-workspace-segment log-mode-button min-h-11 ${selected ? 'is-selected' : ''}`}
            >
              <span className="app-workspace-segment-icon log-mode-icon" aria-hidden="true">
                <ModeIcon />
              </span>
              <span className="app-workspace-segment-copy">
                <span>{option.label}</span>
                <small>{option.description}</small>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
