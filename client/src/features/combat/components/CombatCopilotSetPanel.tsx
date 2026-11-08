import { FileText, List } from 'lucide-react'
import { EmptyState } from '@/shared/ui'
import type { CopilotSetView } from '../model/copilotSetView'
import type { CopilotSetInfo } from '../types'
import CombatCopilotQueueDetail from './CombatCopilotQueueDetail'
import CombatCopilotQueueSummary from './CombatCopilotQueueSummary'

interface CombatCopilotSetPanelProps {
  preview: CopilotSetInfo | null
  view: CopilotSetView
  isRunning: boolean
  isResetting: boolean
  isContinuing: boolean
  onOpenReset: () => void
  onStartNext: () => void
  onCancelSet: () => void
}

export default function CombatCopilotSetPanel({
  preview,
  view,
  isRunning,
  isResetting,
  onOpenReset,
  onCancelSet,
}: CombatCopilotSetPanelProps) {
  const setPreview = preview?.type === 'set' ? preview : null
  const emptyDescription = setPreview?.note
    ? setPreview.note
    : '输入作业链接即可预览，本地作业可直接执行。'
  const isSingle = preview?.type === 'single'
  const panelTitle = isSingle ? '单个作业' : '作业集摘要'

  return (
    <section className="combat-copilot-panel combat-copilot-queue" aria-label={panelTitle}>
      <header className="combat-copilot-panel-head">
        <div className="combat-copilot-panel-title">
          <List size={16} className="brand-text" aria-hidden="true" />
          <h5>{panelTitle}</h5>
          {setPreview && (
            <>
              <span className="combat-copilot-kicker">{setPreview.name}</span>
              <span className="combat-copilot-kicker">prts://s{setPreview.id}</span>
            </>
          )}
          {isSingle && <span className="combat-copilot-kicker">prts://{preview.id}</span>}
        </div>

        {setPreview && !isRunning && setPreview.copilots?.length ? (
          <div className="combat-copilot-panel-actions">
            <button
              type="button"
              onClick={onOpenReset}
              disabled={isResetting}
              className="combat-copilot-text-action"
            >
              {isResetting ? '重置中...' : '重置进度'}
            </button>
          </div>
        ) : null}
      </header>

      {setPreview && setPreview.copilots?.length ? (
        <CombatCopilotQueueSummary
          preview={setPreview}
          view={view}
          onCancelSet={onCancelSet}
        />
      ) : isSingle ? (
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
