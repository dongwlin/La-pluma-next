import { useState } from 'react'
import { FileText } from 'lucide-react'
import { Badge } from '@/shared/ui/badge'
import { Card } from '@/shared/ui/card'
import { Separator } from '@/shared/ui/separator'
import { EmptyState } from '@/shared/components'
import { isActiveRunState, isTerminalRunState, type AgentRun } from '@/features/task-execution'
import {
  describeRoguelikeRunSummary,
  readRoguelikeRunSummary,
  type RoguelikeRunSummary,
} from '../model/runSummary'

interface RoguelikeResultPanelProps {
  run: AgentRun | null
  taskName?: string | null
}

interface RetainedResult {
  runId: string
  summary: RoguelikeRunSummary | null
  durationMs: number | null
}

type ResultBadgeTone = 'success' | 'warning' | 'danger' | 'running' | 'neutral'

const BADGE_SURFACE: Record<ResultBadgeTone, string> = {
  success: 'status-success',
  warning: 'status-warning',
  danger: 'status-danger',
  running: 'brand-chip',
  neutral: 'surface-soft text-muted-foreground',
}

function describeTerminalStateBadge(state: AgentRun['state']): { label: string; tone: ResultBadgeTone } {
  switch (state) {
    case 'succeeded':
      return { label: '成功', tone: 'success' }
    case 'failed':
      return { label: '失败', tone: 'danger' }
    case 'stopped':
      return { label: '已停止', tone: 'warning' }
    case 'interrupted':
      return { label: '已中断', tone: 'warning' }
    default:
      return { label: '无结果', tone: 'neutral' }
  }
}

function formatRunDuration(durationMs: number | null): string | null {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return null
  const totalSeconds = Math.floor(durationMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`
  return `${seconds} 秒`
}

function SummaryContent({
  summary,
  durationMs,
}: {
  summary: RoguelikeRunSummary
  durationMs: number | null
}) {
  const description = describeRoguelikeRunSummary(summary)
  const duration = formatRunDuration(durationMs)
  const metrics = duration
    ? [...description.metrics, { label: '耗时', value: duration }]
    : description.metrics

  return (
    <div className="roguelike-result-content">
      <p className="roguelike-result-message">{summary.message}</p>
      {metrics.length > 0 && (
        <dl className="roguelike-result-metrics">
          {metrics.map((metric, index) => (
            <div key={`${metric.label}-${index}`} className="roguelike-result-metric">
              <dt>{metric.label}</dt>
              <dd>{metric.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {description.events.length > 0 && (
        <div className="roguelike-result-list">
          <h3>事件</h3>
          <ul>
            {description.events.map((event, index) => (
              <li key={`${event}-${index}`}>{event}</li>
            ))}
          </ul>
        </div>
      )}
      {description.notes.length > 0 && (
        <div className="roguelike-result-list">
          <h3>备注</h3>
          <ul>
            {description.notes.map((note, index) => (
              <li key={`${note}-${index}`}>{note}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export default function RoguelikeResultPanel({ run, taskName }: RoguelikeResultPanelProps) {
  const [retained, setRetained] = useState<RetainedResult | null>(null)
  const active = Boolean(run && isActiveRunState(run.state))
  const terminalRun = run && isTerminalRunState(run.state) ? run : null
  const currentSummary = terminalRun ? readRoguelikeRunSummary(terminalRun) : null
  const currentDuration = terminalRun && typeof terminalRun.durationMs === 'number'
    ? terminalRun.durationMs
    : null

  const shouldUpdateRetained = terminalRun !== null && (
    retained === null
    || retained.runId !== terminalRun.runId
    || (retained.summary === null && currentSummary !== null)
    || (retained.durationMs === null && currentDuration !== null)
  )

  if (terminalRun && shouldUpdateRetained) {
    const runId = terminalRun.runId
    setRetained(prior => {
      if (!prior || prior.runId !== runId) {
        return { runId, summary: currentSummary, durationMs: currentDuration }
      }
      const summary = prior.summary ?? currentSummary
      const durationMs = prior.durationMs ?? currentDuration
      if (summary === prior.summary && durationMs === prior.durationMs) return prior
      return { runId: prior.runId, summary, durationMs }
    })
  }

  const description = currentSummary ? describeRoguelikeRunSummary(currentSummary) : null
  const previous = active && retained && retained.runId !== run?.runId ? retained : null
  const progressMessage = typeof run?.progress?.message === 'string' && run.progress.message.trim()
    ? run.progress.message.trim()
    : null
  const runTaskName = typeof taskName === 'string' ? taskName.trim() : ''
  const ownership = run
    ? runTaskName
      ? `任务：${runTaskName}`
      : '任务归属未知（刷新前发起）'
    : null

  const badge: { label: string; tone: ResultBadgeTone } = !run
    ? { label: '未执行', tone: 'neutral' }
    : active
      ? { label: '执行中', tone: 'running' }
      : description
        ? { label: description.statusLabel, tone: description.tone }
        : describeTerminalStateBadge(run.state)

  return (
    <Card
      className="roguelike-panel roguelike-result-panel gap-0 p-0!"
      role="region"
      aria-label="执行结果"
    >
      <div className="roguelike-panel-heading">
        <h2>执行结果</h2>
        <div className="flex shrink-0 items-center">
          <Badge variant="ghost" className={`${BADGE_SURFACE[badge.tone]} pointer-events-none`}>
            {badge.label}
          </Badge>
        </div>
      </div>

      <div className="roguelike-panel-body roguelike-result-body">
        {ownership && <p className="text-xs text-muted-foreground">{ownership}</p>}

        {!run && (
          <EmptyState
            compact
            icon={<FileText size={20} strokeWidth={1.8} />}
            title="还没有执行记录"
            description="执行一次集成战略或生息演算任务后，这里会展示结算与关键结果。"
          />
        )}

        {active && (
          <div className="roguelike-result-active" role="status">
            <strong>执行中</strong>
            <p>{progressMessage ?? '任务已提交，正在等待执行进度。'}</p>
          </div>
        )}

        {previous && (
          previous.summary ? (
            <section className="roguelike-result-previous" aria-label="上次执行结果">
              <Separator aria-hidden="true" className="mb-3.5" />
              <h3>上次执行结果</h3>
              <SummaryContent summary={previous.summary} durationMs={previous.durationMs} />
            </section>
          ) : (
            <p className="roguelike-result-previous-note">上一次执行没有可用的结构化结果。</p>
          )
        )}

        {terminalRun && currentSummary && (
          <SummaryContent summary={currentSummary} durationMs={currentDuration} />
        )}
        {terminalRun && !currentSummary && (
          <p className="roguelike-result-missing">本次执行没有可用的结构化结果</p>
        )}
      </div>
    </Card>
  )
}
