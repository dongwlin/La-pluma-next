/**
 * 作业输入与识别方式面板
 *
 * 输入值仍来自工作区的配置草稿；“识别方式”是预览的局部选择，保存在
 * 工作区创建的会话存储中。切换识别方式只取消在途预览，不改变已显示内容，
 * 也不推动作业集列表重渲染。
 */

import { Button } from '@/shared/ui'
import { usePanelState } from '../hooks/usePanelState'
import type { CopilotPreviewMode } from '../model/copilotPreview'
import type { PanelStateStore } from '../model/panelState'

interface CombatCopilotInputPanelProps {
  input: string
  isLoading: boolean
  previewModeStore: PanelStateStore<CopilotPreviewMode>
  onInputChange: (value: string) => void
  onPreview: () => void
  onCancelPreview: () => void
}

export default function CombatCopilotInputPanel({
  input,
  isLoading,
  previewModeStore,
  onInputChange,
  onPreview,
  onCancelPreview,
}: CombatCopilotInputPanelProps) {
  const [copilotType, setCopilotType] = usePanelState(previewModeStore)

  const handleCopilotTypeChange = (type: CopilotPreviewMode) => {
    // 只取消在途预览并解锁按钮，保留已显示内容，与迁移前一致。
    onCancelPreview()
    setCopilotType(type)
  }

  return (
    <>
      <div className="combat-workspace-section">
        <div className="flex gap-2">
          <label htmlFor="combat-copilot-uri" className="sr-only">作业链接或本地路径</label>
          <input
            id="combat-copilot-uri"
            type="text"
            name="maa-copilot-uri"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="url"
            placeholder="prts://1234、prts://s1234、作业站链接或本地路径"
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
        <div className="mt-2 flex items-center justify-between gap-3 text-xs text-tertiary">
          <p className="truncate">支持作业链接、导入文件和本地作业。</p>
          <details className="group relative shrink-0">
            <summary className="inline-flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center brand-text hover:underline">说明</summary>
            <div className="absolute right-0 z-20 mt-2 hidden w-[min(18rem,calc(100vw-3rem))] space-y-1.5 rounded-lg border border-(--app-border) bg-(--app-surface-solid) p-3 text-left shadow-lg group-open:block">
              <p>• 在 <a href="https://prts.plus/" target="_blank" rel="noopener noreferrer" className="brand-text hover:underline">prts.plus</a> 获取作业链接</p>
              <p>• 单作业：<code className="px-1 bg-gray-100 dark:bg-gray-800 rounded-sm">prts://1234</code>；作业集：<code className="px-1 bg-gray-100 dark:bg-gray-800 rounded-sm">prts://s1234</code></p>
              <p>• 作业站链接会自动识别，也可导入远程或本地作业文件</p>
            </div>
          </details>
        </div>
      </div>

      {/* 作业类型选择 */}
      <div className="flex items-center justify-between gap-3 px-4 text-xs">
        <span className="shrink-0 font-medium text-secondary">识别方式</span>
        <div className="flex min-w-0 max-w-full overflow-hidden rounded-lg border border-(--app-border) bg-(--app-surface-muted) p-0.5">
          <button
            onClick={() => handleCopilotTypeChange('auto')}
            className={`min-h-11 rounded-md px-3 py-1 transition-colors ${
              copilotType === 'auto'
                ? 'combat-segment-active'
                : 'text-secondary hover:bg-white/70 hover:text-primary dark:hover:bg-white/10'
            }`}
          >
            自动
          </button>
          <button
            onClick={() => handleCopilotTypeChange('single')}
            className={`min-h-11 rounded-md px-3 py-1 transition-colors ${
              copilotType === 'single'
                ? 'combat-segment-active'
                : 'text-secondary hover:bg-white/70 hover:text-primary dark:hover:bg-white/10'
            }`}
          >
            单个作业
          </button>
          <button
            onClick={() => handleCopilotTypeChange('set')}
            className={`min-h-11 rounded-md px-3 py-1 transition-colors ${
              copilotType === 'set'
                ? 'combat-segment-active'
                : 'text-secondary hover:bg-white/70 hover:text-primary dark:hover:bg-white/10'
            }`}
          >
            作业集
          </button>
        </div>
      </div>
    </>
  )
}
