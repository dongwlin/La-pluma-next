import { Button } from '@/shared/ui'
import { usePanelState } from '../hooks/usePanelState'
import type { CopilotPreviewMode } from '../model/copilotPreview'
import type { PanelStateStore } from '../model/panelState'
import CombatCopilotInputPanel from './CombatCopilotInputPanel'
import CombatSearchPanel from './CombatSearchPanel'
import type { CombatCopilotSearchProjection } from './combatPanelTypes'

const PREVIEW_MODE_OPTIONS: ReadonlyArray<{ value: CopilotPreviewMode; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'single', label: '单个作业' },
  { value: 'set', label: '作业集' },
]

interface CombatCopilotSourceBarProps {
  input: string
  isLoading: boolean
  hasPreview: boolean
  previewModeStore: PanelStateStore<CopilotPreviewMode>
  search: CombatCopilotSearchProjection
  onInputChange: (value: string) => void
  onPreview: () => void
  onCancelPreview: () => void
  onClear: () => void
}

export default function CombatCopilotSourceBar({
  input,
  isLoading,
  hasPreview,
  previewModeStore,
  search,
  onInputChange,
  onPreview,
  onCancelPreview,
  onClear,
}: CombatCopilotSourceBarProps) {
  const [previewMode, setPreviewMode] = usePanelState(previewModeStore)

  const handlePreviewModeChange = (mode: CopilotPreviewMode) => {
    onCancelPreview()
    setPreviewMode(mode)
  }

  return (
    <section className="combat-copilot-source-bar" aria-label="作业来源">
      <CombatCopilotInputPanel
        input={input}
        isLoading={isLoading}
        onInputChange={onInputChange}
        onPreview={onPreview}
      />

      <div className="combat-copilot-source-tools">
        <CombatSearchPanel {...search} />

        <div className="combat-copilot-source-meta">
          <div className="combat-copilot-mode" role="group" aria-label="识别方式">
            <span className="combat-copilot-mode-label">识别方式</span>
            <div className="combat-copilot-mode-group">
              {PREVIEW_MODE_OPTIONS.map(option => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={previewMode === option.value}
                  onClick={() => handlePreviewModeChange(option.value)}
                  className="combat-copilot-mode-button"
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="combat-copilot-source-actions">
            <details className="combat-copilot-help">
              <summary className="combat-copilot-help-trigger">说明</summary>
              <div className="combat-copilot-help-body">
                <p>• 在 <a href="https://prts.plus/" target="_blank" rel="noopener noreferrer" className="brand-text hover:underline">prts.plus</a> 获取作业链接</p>
                <p>• 单作业：<code className="combat-copilot-code">prts://1234</code>；作业集：<code className="combat-copilot-code">prts://s1234</code></p>
                <p>• 作业站链接会自动识别，也可导入远程或本地作业文件</p>
              </div>
            </details>

            {hasPreview && (
              <Button
                onClick={onClear}
                variant="ghost"
                size="sm"
                className="min-h-11"
              >
                清除预览
              </Button>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
