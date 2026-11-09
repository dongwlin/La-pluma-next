import { ListPlus } from 'lucide-react'
import { Button } from '@/shared/ui'
import type { CopilotPreviewMode } from '../model/copilotPreview'

const PREVIEW_MODE_OPTIONS: ReadonlyArray<{ value: CopilotPreviewMode; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'single', label: '单个作业' },
  { value: 'set', label: '作业集' },
]

interface CombatCopilotInputPanelProps {
  input: string
  isLoading: boolean
  isAddingToQueue?: boolean
  previewMode: CopilotPreviewMode
  onInputChange: (value: string) => void
  onPreviewModeChange: (mode: CopilotPreviewMode) => void
  onPreview: () => void
  onAddToQueue?: () => void
}

export default function CombatCopilotInputPanel({
  input,
  isLoading,
  isAddingToQueue = false,
  previewMode,
  onInputChange,
  onPreviewModeChange,
  onPreview,
  onAddToQueue,
}: CombatCopilotInputPanelProps) {
  return (
    <div className="combat-copilot-input">
      <div className="combat-copilot-input-row">
        <label htmlFor="combat-copilot-uri" className="sr-only">作业链接或服务器文件路径</label>
        <label htmlFor="combat-copilot-preview-mode" className="sr-only">识别方式</label>
        <div className="combat-copilot-uri-field">
          <input
            id="combat-copilot-uri"
            type="text"
            name="maa-copilot-uri"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="url"
            placeholder="prts://1234、prts://s1234、作业站链接或服务器文件路径"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            className="combat-copilot-uri-input"
          />
          <select
            id="combat-copilot-preview-mode"
            name="maa-copilot-preview-mode"
            value={previewMode}
            onChange={(e) => onPreviewModeChange(e.target.value as CopilotPreviewMode)}
            className="combat-copilot-mode-select"
          >
            {PREVIEW_MODE_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
        <Button
          onClick={onPreview}
          disabled={isLoading || !input.trim()}
          loading={isLoading}
          variant="secondary"
          size="md"
          className="shrink-0 px-3"
          icon={
            !isLoading && (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            )
          }
        >
          {!isLoading && '预览'}
        </Button>
        {onAddToQueue && (
          <Button
            onClick={onAddToQueue}
            disabled={isAddingToQueue || isLoading || !input.trim()}
            loading={isAddingToQueue}
            loadingText="加入中"
            variant="secondary"
            size="md"
            className="shrink-0 px-3"
            icon={!isAddingToQueue && <ListPlus size={15} aria-hidden="true" />}
          >
            {!isAddingToQueue && '加入队列'}
          </Button>
        )}
      </div>
      <p className="combat-copilot-hint">支持作业链接、上传 JSON 作业文件，或粘贴服务器可见路径。</p>
    </div>
  )
}
