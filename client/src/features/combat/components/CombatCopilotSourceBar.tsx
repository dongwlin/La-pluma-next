import { usePanelState } from '../hooks/usePanelState'
import type { CopilotPreviewMode } from '../model/copilotPreview'
import type { PanelStateStore } from '../model/panelState'
import CombatCopilotInputPanel from './CombatCopilotInputPanel'
import CombatSearchPanel from './CombatSearchPanel'
import type {
  CombatCopilotFileImportProjection,
  CombatCopilotSearchProjection,
} from './combatPanelTypes'

interface CombatCopilotSourceBarProps {
  input: string
  isLoading: boolean
  isAddingToQueue?: boolean
  previewModeStore: PanelStateStore<CopilotPreviewMode>
  search: CombatCopilotSearchProjection
  fileImport?: CombatCopilotFileImportProjection
  onInputChange: (value: string) => void
  onPreview: () => void
  onAddToQueue?: () => void
  onCancelPreview: () => void
}

export default function CombatCopilotSourceBar({
  input,
  isLoading,
  isAddingToQueue = false,
  previewModeStore,
  search,
  fileImport,
  onInputChange,
  onPreview,
  onAddToQueue,
  onCancelPreview,
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
        isAddingToQueue={isAddingToQueue}
        previewMode={previewMode}
        fileImport={fileImport}
        onInputChange={onInputChange}
        onPreviewModeChange={handlePreviewModeChange}
        onPreview={onPreview}
        onAddToQueue={onAddToQueue}
      />

      <div className="combat-copilot-source-tools">
        <CombatSearchPanel {...search} />

        <div className="combat-copilot-source-meta">
          <div className="combat-copilot-source-actions">
            <details className="combat-copilot-help">
              <summary className="combat-copilot-help-trigger">说明</summary>
              <div className="combat-copilot-help-body">
                <p>• 在 <a href="https://prts.plus/" target="_blank" rel="noopener noreferrer" className="brand-text hover:underline">prts.plus</a> 获取作业链接</p>
                <p>• 单作业：<code className="combat-copilot-code">prts://1234</code>；作业集：<code className="combat-copilot-code">prts://s1234</code></p>
                <p>• 作业站链接会自动识别，也可直接粘贴或导入本地 JSON 文件</p>
                <p>• 识别方式可强制按单个作业或作业集读取，默认按链接判断</p>
              </div>
            </details>
          </div>
        </div>
      </div>
    </section>
  )
}
