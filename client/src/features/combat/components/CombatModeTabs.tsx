/**
 * 作业类型分段控件
 *
 * 只负责当前模式的受控展示、流体高亮测量与方向键导航；模式本身由工作区
 * 持有，不写入配置或存储。
 */

import { motion, useReducedMotion } from 'framer-motion'
import { useFluidTabIndicator } from '@/shared/hooks/useFluidTabIndicator'
import type { CombatMode } from '../types'
import { COMBAT_MODE_OPTIONS } from './CombatTaskCatalog'

interface CombatModeTabsProps {
  activeMode: CombatMode
  onSelect: (mode: CombatMode) => void
}

export default function CombatModeTabs({ activeMode, onSelect }: CombatModeTabsProps) {
  const shouldReduceMotion = useReducedMotion()
  const {
    containerRef,
    activeRect,
    setTabRef,
    handleTabKeyDown,
  } = useFluidTabIndicator(activeMode)

  return (
    <div className="app-workspace-segments app-liquid-tab-pill combat-mode-shell">
      <div
        ref={containerRef}
        className="app-workspace-segment-list"
        role="toolbar"
        aria-label="作业类型"
      >
        {activeRect.width > 0 && (
          <motion.div
            data-testid="combat-mode-highlight"
            aria-hidden="true"
            className="app-workspace-segment-indicator combat-mode-highlight"
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
        {COMBAT_MODE_OPTIONS.map(({ id, title, desc, icon }) => (
          <button
            key={id}
            ref={(element) => {
              setTabRef(id)(element)
            }}
            type="button"
            onClick={() => onSelect(id)}
            onKeyDown={(event) => handleTabKeyDown(
              event,
              COMBAT_MODE_OPTIONS.map(option => option.id),
              onSelect,
            )}
            aria-pressed={activeMode === id}
            tabIndex={activeMode === id ? 0 : -1}
            className={`app-workspace-segment combat-mode-button min-h-11 ${activeMode === id ? 'is-selected' : ''}`}
          >
            <span className="app-workspace-segment-icon combat-mode-icon">
              {icon}
            </span>
            <span className="app-workspace-segment-copy">
              <span>{title}</span>
              <small>{desc}</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
