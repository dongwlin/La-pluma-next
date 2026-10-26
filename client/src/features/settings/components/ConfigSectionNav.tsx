/**
 * 配置 section 导航
 *
 * section 的存储与 window 事件由 `useConfigSection` 订阅；这里只渲染分段
 * 按钮与流体高亮，键盘导航与容器测量仍复用 `useFluidTabIndicator`。
 */

import { motion, useReducedMotion } from 'framer-motion'
import { useFluidTabIndicator } from '@/shared/hooks/useFluidTabIndicator'
import {
  CONFIG_SECTION_IDS,
  type ConfigSectionId,
} from '../model/configSection'
import { CONFIG_SECTION_VIEWS } from './configSectionViews'

export interface ConfigSectionNavProps {
  section: ConfigSectionId
  onSelect: (section: ConfigSectionId) => void
}

export default function ConfigSectionNav({ section, onSelect }: ConfigSectionNavProps) {
  const shouldReduceMotion = useReducedMotion()
  const {
    containerRef,
    activeRect,
    setTabRef,
    handleTabKeyDown,
  } = useFluidTabIndicator(section)

  return (
    <div className="app-workspace-segments app-liquid-tab-pill w-full" data-config-sections>
      <div
        ref={containerRef}
        className="app-workspace-segment-list grid-cols-3"
        role="toolbar"
        aria-label="配置类型"
      >
        {activeRect.width > 0 && (
          <motion.div
            data-testid="config-section-highlight"
            aria-hidden="true"
            className="app-workspace-segment-indicator"
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
        {CONFIG_SECTION_IDS.map(id => {
          const view = CONFIG_SECTION_VIEWS[id]
          const selected = section === id
          return (
            <button
              key={id}
              ref={element => setTabRef(id)(element)}
              type="button"
              onClick={() => onSelect(id)}
              onKeyDown={event => handleTabKeyDown(
                event,
                CONFIG_SECTION_IDS,
                onSelect,
              )}
              aria-pressed={selected}
              tabIndex={selected ? 0 : -1}
              className={`app-workspace-segment min-h-11 ${selected ? 'is-selected' : ''}`}
            >
              <span className="app-workspace-segment-icon">{view.icon}</span>
              <span className="app-workspace-segment-copy">
                <span>{view.name}</span>
                <small>{view.description}</small>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
