/**
 * 本次执行进度面板
 *
 * 绑定工作区当前被跟踪的 Run：展示状态、逐项状态汇总、作业名、关卡、
 * 第 N/M 关、已用时，并提供终止入口。所有事实来自 `run.progress` 与执行
 * 快照投影，面板不推断完成语义、不发起请求；单作业没有 N/M 与逐项数据、
 * 或服务端字段缺失时，对应内容整块省略。
 */

import { useEffect, useState } from 'react'
import { Button } from '@/shared/ui'
import { formatExecutionElapsed } from '../model/executionProgress'
import type { ExecutionProgressView } from '../model/executionProgress'

interface CombatExecutionProgressPanelProps {
  progress: ExecutionProgressView | null
  isStopping: boolean
  onStop: () => void
}

/** 状态词的完整类名映射；动态状态不拼接 Tailwind 类名。 */
const STATE_CHIP_CLASS: Record<string, string> = {
  accepted: 'brand-action text-white',
  running: 'brand-action text-white',
  waiting: 'brand-action text-white',
  stopping: 'brand-action text-white',
  succeeded: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  failed: 'bg-rose-500/10 text-rose-500 dark:text-rose-300',
  stopped: 'bg-black/5 text-secondary dark:bg-white/10',
  interrupted: 'bg-black/5 text-secondary dark:bg-white/10',
}

export default function CombatExecutionProgressPanel({
  progress,
  isStopping,
  onStop,
}: CombatExecutionProgressPanelProps) {
  // 活动 Run 的已用时每秒推进；终态 Run 直接用服务端 durationMs，不再计时。
  const [now, setNow] = useState(() => Date.now())
  const isActive = progress?.isActive ?? false
  const isActiveRun = isActive && progress?.startedAtMs !== null
  // 已用时按秒推进：Run 出现后先对齐一次当前时刻，再按固定间隔走秒。
  useEffect(() => {
    if (!isActiveRun) return undefined
    const tick = () => setNow(Date.now())
    const alignTimer = window.setTimeout(tick, 0)
    const timer = window.setInterval(tick, 1_000)
    return () => {
      window.clearTimeout(alignTimer)
      window.clearInterval(timer)
    }
  }, [isActiveRun])

  if (!progress) return null

  const elapsed = formatExecutionElapsed(
    progress.durationMs
      ?? (progress.startedAtMs === null ? null : Math.max(0, now - progress.startedAtMs)),
  )
  // 已终止、跳过与待执行只在本场执行里出现时才展示，避免常显 0 值。
  const countsText = progress.counts
    ? [
      `已完成 ${progress.counts.success}`,
      `失败 ${progress.counts.failed}`,
      ...(progress.counts.stopped > 0 ? [`已终止 ${progress.counts.stopped}`] : []),
      ...(progress.counts.skipped > 0 ? [`跳过 ${progress.counts.skipped}`] : []),
      ...(progress.counts.pending > 0 ? [`待执行 ${progress.counts.pending}`] : []),
    ].join(' · ')
    : null

  return (
    <section className="combat-workspace-section" aria-label="本次执行进度">
      <div className="flex items-center justify-between gap-2">
        <h5 className="text-sm font-semibold text-primary">本次执行进度</h5>
        <div className="flex items-center gap-2">
          {progress.isActive && (
            <Button
              onClick={onStop}
              disabled={isStopping}
              loading={isStopping}
              loadingText="正在终止"
              variant="danger"
              size="sm"
            >
              终止
            </Button>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span
          className={`rounded-md px-2 py-0.5 text-[11px] ${
            STATE_CHIP_CLASS[progress.state] ?? 'bg-black/5 text-secondary dark:bg-white/10'
          }`}
        >
          {progress.stateLabel}
        </span>
        {countsText && <span className="text-xs text-secondary">{countsText}</span>}
      </div>

      {(progress.name || progress.stage) && (
        <div className="mt-2 border-t border-(--app-border) pt-2">
          {progress.name && <p className="text-sm font-medium text-primary">{progress.name}</p>}
          {progress.stage && <p className="mt-0.5 text-xs text-secondary">关卡: {progress.stage}</p>}
        </div>
      )}

      {(progress.step || elapsed) && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-(--app-border) pt-2 text-xs">
          {progress.step && (
            <span className="font-medium brand-text">
              {progress.state === 'running' ? '正在执行 ' : ''}
              第 {progress.step.current}{progress.step.total !== null ? ` / ${progress.step.total}` : ''} 关
            </span>
          )}
          {elapsed && <span className="text-tertiary">已用时 {elapsed}</span>}
        </div>
      )}
    </section>
  )
}
