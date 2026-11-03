import { useEffect, useState } from 'react'
import { formatExecutionElapsed } from '../model/executionProgress'
import type { ExecutionProgressView } from '../model/executionProgress'

interface CombatExecutionProgressPanelProps {
  progress: ExecutionProgressView | null
}

export default function CombatExecutionProgressPanel({
  progress,
}: CombatExecutionProgressPanelProps) {
  // 活动 Run 的已用时每秒推进；终态 Run 直接用服务端 durationMs，不再计时。
  const [now, setNow] = useState(() => Date.now())
  const isActiveRun = (progress?.isActive ?? false) && progress?.startedAtMs !== null
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
  // 条目位置按本次执行队列编号；both 作业的两个模式各占一项，不能读作关卡数。
  const stepText = progress.step
    ? `本次第 ${progress.step.current}${progress.step.total !== null ? ` / ${progress.step.total}` : ''} 项`
    : null
  if (!stepText && !progress.stage && !progress.name && !elapsed) return null

  return (
    <section className="combat-workspace-section" aria-label="本次执行进度">
      <div className="flex items-center justify-between gap-3">
        <h5 className="text-sm font-semibold text-primary">本次执行进度</h5>
        {elapsed && <span className="text-xs text-tertiary">已用时 {elapsed}</span>}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {stepText && (
          <span className="font-medium brand-text">
            {progress.state === 'running' ? '正在执行 ' : ''}
            {stepText}
          </span>
        )}
        {!stepText && progress.name && <span className="text-secondary">{progress.name}</span>}
        {progress.stage && <span className="text-secondary">关卡: {progress.stage}</span>}
      </div>
    </section>
  )
}
