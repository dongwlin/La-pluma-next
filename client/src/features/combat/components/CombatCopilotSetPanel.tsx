import { useState } from 'react'
import { FileText, List } from 'lucide-react'
import { EmptyState } from '@/shared/ui'
import { useCopilotSetItemFollow } from '../hooks/useCopilotSetItemFollow'
import type { CopilotSetView } from '../model/copilotSetView'
import type { CopilotSetInfo } from '../types'
import CombatCopilotQueueDetail from './CombatCopilotQueueDetail'
import CombatCopilotQueueRow from './CombatCopilotQueueRow'
import CombatCopilotQueueSummary from './CombatCopilotQueueSummary'

interface CombatCopilotSetPanelProps {
  preview: CopilotSetInfo | null
  view: CopilotSetView
  selected: ReadonlySet<number>
  isRunning: boolean
  isResetting: boolean
  isContinuing: boolean
  automationAvailable: boolean
  unavailableMessage: string
  onToggle: (index: number) => void
  onToggleAll: () => void
  onOpenReset: () => void
  onStartNext: () => void
  onCancelSet: () => void
}

export default function CombatCopilotSetPanel({
  preview,
  view,
  selected,
  isRunning,
  isResetting,
  onToggle,
  onToggleAll,
  onOpenReset,
  onCancelSet,
}: CombatCopilotSetPanelProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)
  const listRef = useCopilotSetItemFollow({
    currentIndex: view.currentIndex,
    hasList: preview?.type === 'set' && !!preview.copilots?.length,
  })

  const isSetPreview = preview?.type === 'set' && !!preview.copilots?.length
  const setPreview = isSetPreview ? preview : null
  const allSelected = setPreview ? selected.size === setPreview.copilots?.length : false
  const emptyDescription = preview?.type === 'set' && preview.note
    ? preview.note
    : '输入作业链接即可预览，本地作业可直接执行。'

  return (
    <section className="combat-copilot-panel combat-copilot-queue" aria-label="作业队列">
      <header className="combat-copilot-panel-head">
        <div className="combat-copilot-panel-title">
          <List size={16} className="brand-text" aria-hidden="true" />
          <h5>作业队列</h5>
          {setPreview && (
            <span className="combat-copilot-kicker">作业集 · prts://s{setPreview.id}</span>
          )}
        </div>

        {setPreview && !isRunning && (
          <div className="combat-copilot-panel-actions">
            <button
              type="button"
              onClick={onOpenReset}
              disabled={isResetting}
              className="combat-copilot-text-action"
            >
              {isResetting ? '重置中...' : '重置进度'}
            </button>
            <span className="combat-copilot-divider" aria-hidden="true" />
            <button
              type="button"
              onClick={onToggleAll}
              className="combat-copilot-text-action is-accent"
            >
              {allSelected ? '清空待执行' : '全选待执行'}
            </button>
          </div>
        )}
      </header>

      {setPreview && setPreview.copilots && setPreview.copilots.length > 0 ? (
        <>
          <CombatCopilotQueueSummary
            preview={setPreview}
            view={view}
            onCancelSet={onCancelSet}
          />
          <div
            ref={listRef}
            data-copilot-set-list
            role="list"
            aria-label="作业队列"
            className="combat-copilot-queue-list"
          >
            {setPreview.copilots.map((copilot, index) => {
              const runStatus = view.itemStatuses.get(index)
              const isFailed = runStatus === 'failed'
              const isStopped = runStatus === 'stopped'
              const isSuccess = view.runCompletedIndexes.has(index) && !isFailed && !isStopped
              const isCompleted = isSuccess || isFailed || isStopped
              const isSkipped = runStatus === 'skipped'
              const isCurrent = runStatus === 'running'
              const isHistoryDone = !isCurrent
                && !isSkipped
                && !isCompleted
                && view.historyCompletedIndexes.has(index)
              const detailId = `combat-copilot-detail-${setPreview.id}-${index}`
              const expanded = expandedIndex === index

              return (
                <CombatCopilotQueueRow
                  key={`${copilot.id}-${index}`}
                  copilot={copilot}
                  index={index}
                  selected={selected.has(index)}
                  disabled={isRunning}
                  expanded={expanded}
                  detailId={detailId}
                  isCurrent={isCurrent}
                  isSuccess={isSuccess}
                  isFailed={isFailed}
                  isStopped={isStopped}
                  isSkipped={isSkipped}
                  isHistoryDone={isHistoryDone}
                  onToggle={() => onToggle(index)}
                  onToggleExpanded={() => setExpandedIndex(expanded ? null : index)}
                />
              )
            })}
          </div>
        </>
      ) : preview?.type === 'single' ? (
        <div className="combat-copilot-single">
          <div className="combat-copilot-single-head">
            <span className="combat-copilot-tag">单个作业</span>
            <span className="combat-copilot-single-uri">prts://{preview.id}</span>
          </div>
          {preview.note && <p className="combat-copilot-summary-note">{preview.note}</p>}
          <CombatCopilotQueueDetail
            detailId={`combat-copilot-single-detail-${preview.id}`}
            item={{
              id: preview.id,
              name: preview.name,
              stage: preview.stage,
              operators: preview.operators,
              uri: `prts://${preview.id}`,
            }}
          />
        </div>
      ) : (
        <EmptyState
          compact
          className="combat-copilot-empty"
          icon={<FileText size={24} strokeWidth={1.7} />}
          title="等待作业"
          description={emptyDescription}
        />
      )}
    </section>
  )
}
