import { Check, ChevronDown } from 'lucide-react'
import { formatCopilotApCost } from '../model/copilotPayload'
import type { CopilotSetItem } from '../types'
import CombatCopilotQueueDetail from './CombatCopilotQueueDetail'

interface CombatCopilotQueueRowProps {
  copilot: CopilotSetItem
  index: number
  selected: boolean
  disabled: boolean
  expanded: boolean
  detailId: string
  isCurrent: boolean
  isSuccess: boolean
  isFailed: boolean
  isStopped: boolean
  isSkipped: boolean
  isHistoryDone: boolean
  onToggle: () => void
  onToggleExpanded: () => void
}

export default function CombatCopilotQueueRow({
  copilot,
  index,
  selected,
  disabled,
  expanded,
  detailId,
  isCurrent,
  isSuccess,
  isFailed,
  isStopped,
  isSkipped,
  isHistoryDone,
  onToggle,
  onToggleExpanded,
}: CombatCopilotQueueRowProps) {
  const statusLabel = isCurrent
    ? '执行中'
    : isSkipped
      ? '已跳过'
      : isFailed
        ? '待重试'
        : isStopped
          ? '已终止'
          : isSuccess
            ? '已完成'
            : isHistoryDone
              ? '历史已通关'
              : '待执行'
  const marker = isSuccess
    ? '✓'
    : isFailed
      ? '✗'
      : isStopped || isSkipped
        ? '–'
        : isHistoryDone
          ? '✓'
          : String(index + 1)
  const rowState = isCurrent
    ? ' is-current'
    : isSuccess
      ? ' is-success'
      : isFailed
        ? ' is-failed'
        : isStopped
          ? ' is-stopped'
          : isSkipped || isHistoryDone
            ? ' is-muted'
            : ''

  return (
    <div
      data-copilot-item-index={index}
      role="listitem"
      className={`combat-copilot-row${rowState}`}
    >
      <div className="combat-copilot-row-main">
        <button
          type="button"
          onClick={onToggle}
          disabled={disabled}
          aria-pressed={selected}
          aria-label={`${selected ? '取消选择' : '选择'}第 ${index + 1} 个作业`}
          className="combat-copilot-check"
        >
          <span className={`combat-copilot-check-box${selected ? ' is-selected' : ''}`}>
            {selected && <Check size={12} strokeWidth={3} aria-hidden="true" />}
          </span>
        </button>

        <span className="combat-copilot-marker">{marker}</span>

        <div className="combat-copilot-row-body">
          <div className="combat-copilot-row-name">
            <span className="combat-copilot-row-title">{copilot.name || `作业 #${copilot.id}`}</span>
            {copilot.presetFormation && (
              <span className="combat-copilot-tag">预设编队 · 仅普通</span>
            )}
            {copilot.completedModes?.map(mode => (
              <span key={mode} className="combat-copilot-tag is-complete">
                {mode === 'raid' ? '突袭已完成' : '普通已完成'}
              </span>
            ))}
          </div>
          <div className="combat-copilot-row-meta">
            {copilot.stage && (
              <span>{copilot.stage} · 理智 {formatCopilotApCost(copilot.apCost)}</span>
            )}
            <span className="combat-copilot-row-id">prts://{copilot.id}</span>
          </div>
        </div>

        <span className="combat-copilot-status">{statusLabel}</span>

        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-controls={detailId}
          aria-label={`${expanded ? '收起' : '展开'}第 ${index + 1} 个作业详情`}
          className="combat-copilot-expand"
        >
          <ChevronDown
            size={16}
            aria-hidden="true"
            className={`combat-copilot-expand-icon${expanded ? ' is-expanded' : ''}`}
          />
        </button>
      </div>

      {expanded && <CombatCopilotQueueDetail detailId={detailId} item={copilot} />}
    </div>
  )
}
