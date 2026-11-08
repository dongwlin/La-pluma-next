import { Button } from '@/shared/ui'
import type { CopilotSetView } from '../model/copilotSetView'
import type { CopilotSetInfo } from '../types'

interface CombatCopilotQueueSummaryProps {
  preview: CopilotSetInfo
  view: CopilotSetView
  onCancelSet: () => void
}

export default function CombatCopilotQueueSummary({
  preview,
  view,
  onCancelSet,
}: CombatCopilotQueueSummaryProps) {
  const { total, completed, pending, failed, stopped, skipped } = view.progress
  const nextIndex = view.resumeIndex
  const nextCopilot = nextIndex >= 0 ? preview.copilots?.[nextIndex] ?? null : null
  const waitingTotal = Math.max(preview.copilots?.length ?? 0, view.activeSetRun?.itemCount ?? 0)

  return (
    <div className="combat-copilot-summary">
      <div className="combat-copilot-summary-head">
        <div className="combat-copilot-summary-copy">
          <span className="combat-copilot-summary-label">历史续跑进度</span>
          <span className="combat-copilot-summary-title">
            {nextCopilot ? `下次从第 ${nextIndex + 1} 关继续` : '没有待续跑的作业'}
          </span>
          <span className="combat-copilot-summary-meta">
            {view.attemptedCount > 0 ? `本次已执行 ${view.attemptedCount} 个` : `共 ${total} 个作业（含历史通关）`}
          </span>
        </div>
        <div className="combat-copilot-summary-chips">
          <span className="combat-copilot-chip is-pending">待 {pending}</span>
          <span className="combat-copilot-chip">已通关 {completed}</span>
          <span className={`combat-copilot-chip${failed > 0 ? ' is-failed' : ''}`}>失败 {failed}</span>
          {stopped > 0 && <span className="combat-copilot-chip">已终止 {stopped}</span>}
          {skipped > 0 && <span className="combat-copilot-chip is-muted">跳过 {skipped}</span>}
        </div>
      </div>

      <div className="combat-copilot-progress">
        <div
          className="combat-copilot-progress-bar"
          style={{ width: `${total > 0 ? (completed / total) * 100 : 0}%` }}
        />
      </div>

      {nextCopilot ? (
        <div className="combat-copilot-resume">
          <span className="combat-copilot-resume-label">续跑目标</span>
          <span className="combat-copilot-resume-uri">prts://{nextCopilot.id}</span>
          <span className="combat-copilot-resume-name">
            {nextCopilot.stage || nextCopilot.name || `第 ${nextIndex + 1} 关`}
          </span>
        </div>
      ) : (
        <p className="combat-copilot-summary-note">需要重打时点击“重置进度”。</p>
      )}

      {view.waitingEntry && (
        <div className="combat-copilot-waiting">
          <div className="combat-copilot-waiting-head">
            <span className="combat-copilot-tag">下一关</span>
            <span className="combat-copilot-waiting-index">
              第 {(view.waitingEntryIndex ?? 0) + 1} / {waitingTotal} 关
            </span>
            <span className="combat-copilot-waiting-uri">
              prts://{view.waitingCopilot?.id ?? view.waitingEntry.copilotId}
            </span>
          </div>
          <p className="combat-copilot-waiting-name">
            {view.waitingCopilot?.name || `作业 #${view.waitingEntry.copilotId ?? ''}`}
          </p>
          {(view.waitingCopilot?.stage || view.waitingEntry.stage) && (
            <p className="combat-copilot-waiting-stage">
              {view.waitingCopilot?.stage || view.waitingEntry.stage}
            </p>
          )}
          <p className="combat-copilot-waiting-hint">请在游戏中进入下一关界面后点击「开始下一关」。</p>
          <Button
            onClick={onCancelSet}
            variant="secondary"
            size="md"
            className="min-h-11"
          >
            终止执行
          </Button>
        </div>
      )}
    </div>
  )
}
