import { useState } from 'react'
import { Check, ChevronDown, ChevronUp, ListChecks, RotateCcw, SkipForward, Trash2 } from 'lucide-react'
import { Button, EmptyState, IconButton } from '@/shared/ui'
import type { CopilotDetailTarget } from '../model/copilotDetail'
import { formatCopilotApCost } from '../model/copilotPayload'
import type { CopilotQueueItemStatus } from '../model/copilotQueueRun'
import type { CopilotSetItemStatus } from '../model/copilotSetRun'
import type { CopilotQueueEntry, CopilotQueueSource } from '../model/copilotQueue'
import CombatCopilotDetailLayer from './CombatCopilotDetailLayer'
import type { CombatCopilotQueueProjection } from './combatPanelTypes'

const SOURCE_LABELS: Record<CopilotQueueSource, string> = {
  link: '链接',
  set: '作业集',
  file: '本地',
}

const STATUS_LABELS: Record<CopilotSetItemStatus, string> = {
  pending: '待执行',
  running: '执行中',
  success: '已完成',
  failed: '待重试',
  skipped: '已跳过',
  stopped: '已终止',
}

const QUEUE_STATUS_LABELS: Record<CopilotQueueItemStatus, string> = {
  pending: '待执行',
  running: '执行中',
  success: '已完成',
  failed: '执行失败',
  skipped: '已跳过',
  stopped: '已终止',
}

interface QueueRowState {
  label: string
  error?: string
}

function firstLine(value: string): string {
  const line = value.split(/\r?\n/).map(part => part.trim()).find(Boolean)
  return line ?? value.trim()
}

function describeRowState(
  entry: CopilotQueueEntry,
  queue: CombatCopilotQueueProjection,
): QueueRowState {
  const queueState = queue.queueRun?.statuses.get(entry.id)
  if (queueState) {
    return {
      label: QUEUE_STATUS_LABELS[queueState.status],
      ...(queueState.error ? { error: queueState.error } : {}),
    }
  }
  if (entry.setId && entry.setId === queue.setId && entry.setItemIndex !== undefined) {
    const status = queue.itemStatuses.get(entry.setItemIndex)
    if (status) {
      const error = queue.itemErrors.get(entry.setItemIndex)
      return {
        label: STATUS_LABELS[status],
        ...(error ? { error } : {}),
      }
    }
  }
  if (queue.isRunning && queue.submittedEntryIds.has(entry.id)) return { label: '本次已提交' }
  return { label: '待执行' }
}

function describeSource(entry: CopilotQueueEntry): string {
  if (entry.source === 'set' && entry.setId) return `作业集 prts://s${entry.setId}`
  return SOURCE_LABELS[entry.source]
}

function describeTitle(entry: CopilotQueueEntry): string {
  return entry.title || entry.stage || entry.fileName || entry.uri
}

function submitsAsSet(
  entries: readonly CopilotQueueEntry[],
  selected: ReadonlySet<string>,
  setId: string | null,
): boolean {
  if (!setId) return false
  const indexes: number[] = []
  for (const entry of entries) {
    if (!selected.has(entry.id)) continue
    if (entry.setId !== setId || entry.setItemIndex === undefined) return false
    if (indexes.length && entry.setItemIndex <= indexes[indexes.length - 1]!) return false
    indexes.push(entry.setItemIndex)
  }
  return indexes.length > 0
}

function toDetailTarget(
  entry: CopilotQueueEntry,
  queue: CombatCopilotQueueProjection,
): CopilotDetailTarget {
  const state = describeRowState(entry, queue)
  return {
    title: describeTitle(entry),
    stage: entry.stage,
    stageId: entry.stageId,
    apCost: entry.apCost,
    sourceLabel: describeSource(entry),
    uri: entry.uri,
    presetFormation: entry.presetFormation,
    supportsRaid: entry.supportsRaid,
    completedModes: entry.completedModes,
    operators: entry.operatorDetails ?? entry.operators?.map(name => ({ name })),
    groups: entry.groups,
    statusLabel: state.label,
    ...(state.error ? { error: state.error } : {}),
  }
}

interface CombatCopilotQueuePanelProps {
  queue: CombatCopilotQueueProjection
}

export default function CombatCopilotQueuePanel({ queue }: CombatCopilotQueuePanelProps) {
  const [detailEntryId, setDetailEntryId] = useState<string | null>(null)
  const { entries, selected } = queue
  const checkedCount = entries.filter(entry => selected.has(entry.id)).length
  const locked = queue.isRunning || queue.isSubmitting
  const detailEntry = detailEntryId
    ? entries.find(entry => entry.id === detailEntryId) ?? null
    : null
  const waitingForNext = queue.queueRun?.isWaiting === true
  const failurePolicy = queue.queueRun?.failurePolicy ?? queue.failurePolicy
  const failedEntries = queue.queueRun?.isTerminal
    ? entries.filter(entry => queue.queueRun?.statuses.get(entry.id)?.status === 'failed')
    : []

  return (
    <section
      className="combat-copilot-panel combat-copilot-mine"
      aria-label="作业队列"
    >
      <header className="combat-copilot-panel-head">
        <div className="combat-copilot-panel-title">
          <ListChecks size={16} className="brand-text" aria-hidden="true" />
          <h5>作业队列</h5>
          <span className="combat-copilot-kicker">共 {entries.length} 项</span>
        </div>

        <div className="combat-copilot-panel-actions">
          <button
            type="button"
            onClick={queue.onClear}
            disabled={locked || entries.length === 0}
            className="combat-copilot-text-action"
          >
            清空
          </button>
        </div>
      </header>

      {entries.length === 0 ? (
        <EmptyState
          compact
          className="combat-copilot-empty"
          icon={<ListChecks size={24} strokeWidth={1.7} />}
          title="队列为空"
          description="从作业链接、关卡搜索或本地文件加入作业；输入作业集链接会自动展开到队列。"
        />
      ) : (
        <>
          <p className="combat-copilot-mine-summary">
            已勾选 {checkedCount} / {entries.length} 项，
            {submitsAsSet(entries, selected, queue.setId)
              ? '按作业集顺序执行，可查看逐项状态。'
              : `按队列顺序执行，失败${failurePolicy === 'stop' ? '即停' : '后继续'}，可查看逐项状态。`}
          </p>
          {(waitingForNext || failedEntries.length > 0) && (
            <div className="combat-copilot-panel-actions px-3 pb-2">
              {waitingForNext && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={queue.onContinueQueue}
                    disabled={!queue.automationAvailable || queue.isContinuing}
                    loading={queue.isContinuing}
                    loadingText="正在开始"
                    title={!queue.automationAvailable ? queue.unavailableMessage : undefined}
                  >
                    开始下一项
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={queue.onSkipEntry}
                    disabled={!queue.automationAvailable || queue.isSkipping}
                    loading={queue.isSkipping}
                    loadingText="正在跳过"
                    title={!queue.automationAvailable ? queue.unavailableMessage : undefined}
                    icon={<SkipForward size={14} aria-hidden="true" />}
                  >
                    跳过此项
                  </Button>
                </>
              )}
              {failedEntries.length > 0 && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={queue.onRetryFailed}
                  disabled={locked || !queue.automationAvailable}
                  title={!queue.automationAvailable ? queue.unavailableMessage : undefined}
                  icon={<RotateCcw size={14} aria-hidden="true" />}
                >
                  重试失败项
                </Button>
              )}
            </div>
          )}
          <div role="list" aria-label="作业队列" className="combat-copilot-mine-list">
            {entries.map((entry, index) => {
              const checked = selected.has(entry.id)
              const title = describeTitle(entry)
              const expanded = detailEntryId === entry.id
              const state = describeRowState(entry, queue)
              const errorLine = state.error ? firstLine(state.error) : null

              return (
                <div
                  key={entry.id}
                  role="listitem"
                  data-copilot-set-item-index={entry.setItemIndex}
                  className="combat-copilot-mine-row"
                >
                  <button
                    type="button"
                    onClick={() => queue.onToggle(entry.id)}
                    disabled={locked}
                    aria-pressed={checked}
                    aria-label={`${checked ? '取消选择' : '选择'}队列第 ${index + 1} 项 ${title}`}
                    className="combat-copilot-mine-check"
                  >
                    <span className={`combat-copilot-mine-check-box${checked ? ' is-selected' : ''}`}>
                      {checked && <Check size={12} strokeWidth={3} aria-hidden="true" />}
                    </span>
                  </button>

                  <span className="combat-copilot-mine-marker" aria-hidden="true">{index + 1}</span>

                  <button
                    type="button"
                    onClick={() => setDetailEntryId(entry.id)}
                    aria-expanded={expanded}
                    aria-label={`查看队列第 ${index + 1} 项详情 ${title}`}
                    className="combat-copilot-mine-body"
                  >
                    <span className="combat-copilot-mine-title">{title}</span>
                    <span className="combat-copilot-mine-meta">
                      <span className="combat-copilot-mine-tag">{describeSource(entry)}</span>
                      {entry.stage && <span>{entry.stage}</span>}
                      {entry.source !== 'file' && <span>理智 {formatCopilotApCost(entry.apCost)}</span>}
                      {entry.source === 'file' && entry.fileName && <span>{entry.fileName}</span>}
                      {entry.completedModes?.map(mode => (
                        <span key={mode} className="combat-copilot-mine-tag is-complete">
                          {mode === 'raid' ? '突袭已完成' : '普通已完成'}
                        </span>
                      ))}
                      {errorLine && <span className="form-error-text">{errorLine}</span>}
                    </span>
                  </button>

                  <span className="combat-copilot-mine-status">{state.label}</span>

                  <div className="combat-copilot-mine-actions">
                    <IconButton
                      icon={<ChevronUp size={16} aria-hidden="true" />}
                      title={`上移第 ${index + 1} 项`}
                      aria-label={`上移第 ${index + 1} 项 ${title}`}
                      disabled={locked || index === 0}
                      onClick={() => queue.onMove(entry.id, 'up')}
                    />
                    <IconButton
                      icon={<ChevronDown size={16} aria-hidden="true" />}
                      title={`下移第 ${index + 1} 项`}
                      aria-label={`下移第 ${index + 1} 项 ${title}`}
                      disabled={locked || index === entries.length - 1}
                      onClick={() => queue.onMove(entry.id, 'down')}
                    />
                    <IconButton
                      icon={<Trash2 size={15} aria-hidden="true" />}
                      title={`删除第 ${index + 1} 项`}
                      aria-label={`删除第 ${index + 1} 项 ${title}`}
                      variant="ghost"
                      disabled={locked}
                      onClick={() => queue.onRemove(entry.id)}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      <CombatCopilotDetailLayer
        target={detailEntry ? toDetailTarget(detailEntry, queue) : null}
        onClose={() => setDetailEntryId(null)}
      />
    </section>
  )
}
