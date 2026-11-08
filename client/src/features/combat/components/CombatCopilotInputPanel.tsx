import { Button } from '@/shared/ui'

interface CombatCopilotInputPanelProps {
  input: string
  isLoading: boolean
  onInputChange: (value: string) => void
  onPreview: () => void
}

export default function CombatCopilotInputPanel({
  input,
  isLoading,
  onInputChange,
  onPreview,
}: CombatCopilotInputPanelProps) {
  return (
    <div className="combat-copilot-input">
      <div className="combat-copilot-input-row">
        <label htmlFor="combat-copilot-uri" className="sr-only">作业链接或服务器文件路径</label>
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
          className="app-input app-native-control min-h-11 min-w-0 flex-1 font-mono control-surface"
        />
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
      </div>
      <p className="combat-copilot-hint">支持作业链接、上传 JSON 作业文件，或粘贴服务器可见路径。</p>
    </div>
  )
}
