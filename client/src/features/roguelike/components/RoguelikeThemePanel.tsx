/**
 * 肉鸽主题面板
 *
 * 主题快捷项与自定义输入都只编辑当前模式的 `taskInputs`；持久化仍由工作区通过
 * user-config 协调器提交，本面板不直接读写存储或服务端。
 */

import { Check } from 'lucide-react'
import { Input, SmoothPanel } from '@/shared/ui'
import { ROGUELIKE_THEME_PRESETS } from '../model/roguelikeTasks'
import type { RoguelikeTask } from '../types'

interface RoguelikeThemePanelProps {
  task: RoguelikeTask
  theme: string
  onThemeChange: (value: string) => void
}

export default function RoguelikeThemePanel({
  task,
  theme,
  onThemeChange,
}: RoguelikeThemePanelProps) {
  const presets = ROGUELIKE_THEME_PRESETS[task.id]

  return (
    <SmoothPanel className="roguelike-panel roguelike-theme-panel">
      <div className="roguelike-panel-heading">
        <div>
          <h3>主题</h3>
          <p>选择本次运行内容</p>
        </div>
        <span>{presets.length} 个可用</span>
      </div>
      <div className="roguelike-panel-body">
        <div className="roguelike-theme-grid">
          {presets.map(preset => {
            const selected = theme === preset.value
            return (
              <button
                key={preset.value}
                type="button"
                onClick={() => onThemeChange(preset.value)}
                aria-pressed={selected}
                className={`roguelike-theme-option min-h-11 ${selected ? 'is-active' : ''}`}
              >
                <span className="roguelike-theme-copy">
                  <strong>{preset.label}</strong>
                  <small>{preset.value}</small>
                </span>
                {selected && <Check size={15} strokeWidth={2.4} aria-hidden="true" />}
              </button>
            )
          })}
        </div>
        <Input
          id={`roguelike-${task.id}-theme`}
          name={`maa-${task.id}-theme`}
          type="text"
          label="自定义主题代号"
          placeholder={task.placeholder}
          value={theme}
          onChange={onThemeChange}
          className="roguelike-custom-theme"
        />
      </div>
    </SmoothPanel>
  )
}
