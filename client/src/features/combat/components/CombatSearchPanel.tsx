import { Button } from '@/shared/ui'
import { usePanelState } from '../hooks/usePanelState'
import type { PanelStateStore } from '../model/panelState'
import type { CopilotSearchResult, CopilotStageCandidate } from '../types'

interface CombatSearchPanelProps {
  stageStore: PanelStateStore<string>
  selectionStore: PanelStateStore<string>
  result: CopilotSearchResult | null
  searching: boolean
  addingUri: string | null
  candidates: readonly CopilotStageCandidate[]
  activeStage: CopilotStageCandidate | null
  onSearch: (term: string) => void
  onCancel: () => void
  onSelectStage: (candidate: CopilotStageCandidate) => void
  onSelectUri: (uri: string) => void
  onAddToQueue: (uri: string) => void
}

export default function CombatSearchPanel({
  stageStore,
  selectionStore,
  result,
  searching,
  addingUri,
  candidates,
  activeStage,
  onSearch,
  onCancel,
  onSelectStage,
  onSelectUri,
  onAddToQueue,
}: CombatSearchPanelProps) {
  const [stage, setStage] = usePanelState(stageStore)
  const [selectedUri] = usePanelState(selectionStore)

  const handleStageChange = (value: string) => {
    onCancel()
    setStage(value)
  }

  const recommendedUri = result?.recommended?.uri ?? result?.copilots?.[0]?.uri

  return (
    <div className="combat-copilot-search">
      <div className="combat-copilot-search-row">
        <label htmlFor="combat-stage-search" className="sr-only">搜索关卡作业</label>
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
          className="app-input app-native-control min-h-11 min-w-0 flex-1 control-surface"
        />
        <Button
          onClick={() => onSearch(stage)}
          disabled={searching || !stage.trim()}
          loading={searching}
          variant="secondary"
          size="md"
          className="shrink-0 px-3"
        >
          {!searching && '搜索'}
        </Button>
      </div>

      {candidates.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-secondary">该代号对应多个关卡，请选择：</span>
          <div className="combat-copilot-search-results" role="group" aria-label="匹配的关卡">
            {candidates.map((candidate) => (
              <div key={candidate.stageId} className="combat-copilot-search-result">
                <button
                  type="button"
                  onClick={() => onSelectStage(candidate)}
                  className="combat-copilot-search-result-main"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 font-mono text-xs brand-text">{candidate.code}</span>
                    <span className="max-w-20 truncate text-xs text-secondary">{candidate.name}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-secondary">{candidate.category}</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeStage && (
        <p className="flex min-w-0 items-center gap-2 text-xs text-secondary">
          当前关卡
          <span className="shrink-0 font-mono brand-text">{activeStage.code}</span>
          <span className="truncate">{activeStage.name}</span>
        </p>
      )}

      {result && result.copilots && result.copilots.length > 0 && (
        <div className="combat-copilot-search-results">
          {result.copilots.map((copilot) => {
            const isSelected = selectedUri === copilot.uri
            const isAdding = addingUri === copilot.uri
            return (
              <div
                key={copilot.id}
                className={`combat-copilot-search-result${isSelected ? ' is-active' : ''}`}
              >
                <button
                  type="button"
                  onClick={() => onSelectUri(copilot.uri)}
                  className="combat-copilot-search-result-main"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 font-mono text-xs brand-text">{copilot.uri}</span>
                    <span className="max-w-20 truncate text-xs text-secondary">{copilot.title}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {isSelected && (
                      <span className="rounded-md px-1.5 py-0.5 text-[11px] brand-chip">已选中</span>
                    )}
                    {recommendedUri === copilot.uri && (
                      <span className="rounded-md px-1.5 py-0.5 text-[11px] brand-chip">推荐</span>
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onAddToQueue(copilot.uri)}
                  disabled={isAdding}
                  aria-label={`加入队列: ${copilot.title ?? copilot.uri}`}
                  className="combat-copilot-search-result-add"
                >
                  {isAdding ? '加入中' : '加入队列'}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
