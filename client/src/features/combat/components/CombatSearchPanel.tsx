/**
 * 普通关卡搜索面板
 *
 * 搜索词与"已选中"高亮是搜索面板的局部状态，保存在工作区创建的会话
 * 存储中；结果、loading 与取消由工作区持有的领域搜索入口提供。输入变化
 * 只取消在途搜索并更新本面板，不重建作业集列表。
 */

import { Button } from '@/shared/ui'
import { usePanelState } from '../hooks/usePanelState'
import type { PanelStateStore } from '../model/panelState'
import type { CopilotSearchResult } from '../types'

interface CombatSearchPanelProps {
  stageStore: PanelStateStore<string>
  selectionStore: PanelStateStore<string>
  result: CopilotSearchResult | null
  searching: boolean
  onSearch: (term: string) => void
  onCancel: () => void
  onSelectUri: (uri: string) => void
}

export default function CombatSearchPanel({
  stageStore,
  selectionStore,
  result,
  searching,
  onSearch,
  onCancel,
  onSelectUri,
}: CombatSearchPanelProps) {
  const [stage, setStage] = usePanelState(stageStore)
  const [selectedUri] = usePanelState(selectionStore)

  const handleStageChange = (value: string) => {
    // 输入变化即放弃在途搜索；旧响应不会写入新的展示状态。
    onCancel()
    setStage(value)
  }

  return (
    <div className="combat-workspace-section">
      <h5 className="mb-3 flex items-center space-x-2 text-sm font-semibold text-primary">
        <svg className="w-4 h-4 brand-text" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <span>快速搜索</span>
      </h5>
      <div className="flex space-x-2">
        <label htmlFor="combat-stage-search" className="sr-only">搜索关卡作业</label>
        {/* v4 的 space-x 只给非末子元素加 end margin；补回 sr-only label 参与计数时的 v3 左间距 */}
        <input
          id="combat-stage-search"
          type="text"
          name="maa-copilot-stage-search"
          placeholder="关卡名称，如：1-7、CE-6"
          value={stage}
          onChange={(e) => handleStageChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || searching || !stage.trim()) return
            e.preventDefault()
            onSearch(stage)
          }}
          className="app-input app-native-control min-h-11 min-w-0 flex-1 ml-2 control-surface"
        />
        <Button
          onClick={() => onSearch(stage)}
          disabled={searching || !stage.trim()}
          loading={searching}
          variant="secondary"
          size="md"
          className="px-3"
        >
          {!searching && '搜索'}
        </Button>
      </div>
      <p className="mt-2 text-xs text-tertiary">支持关卡代号或关卡名，例如 1-7、CE-6。</p>

      {/* 搜索结果 */}
      {result && result.copilots && (
        <div className="mt-3 max-h-32 space-y-1 overflow-y-auto">
          {result.copilots.slice(0, 5).map((copilot, idx) => (
            <button
              key={copilot.id}
              onClick={() => onSelectUri(copilot.uri)}
              className={`flex min-h-11 w-full items-center justify-between rounded-lg border px-3 py-1.5 text-left text-xs transition-all ${
                selectedUri === copilot.uri
                  ? 'brand-action-subtle border-(--app-accent)'
                  : 'border-(--app-border) bg-(--app-surface) hover:border-(--app-accent)'
              }`}
            >
              <div className="flex items-center space-x-2">
                <span className="font-mono brand-text">{copilot.uri}</span>
                <span className="max-w-20 truncate text-secondary">{copilot.title}</span>
              </div>
              <div className="flex items-center gap-1.5">
                {selectedUri === copilot.uri && (
                  <span className="whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs brand-chip">已选中</span>
                )}
                {idx === 0 && (
                  <span className="whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs brand-chip">推荐</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
