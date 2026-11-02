/**
 * 全局执行状态条
 *
 * 应用外壳常驻的活动执行入口：只要控制器快照里有活动 Run，就在任意页面展示
 * 它的任务名或阶段、当前作业或关卡与已用时，并复用既有目标停止能力提供终止入口。
 * 没有活动 Run 时不渲染；本组件只订阅快照，不创建第二份观察循环。
 */

import { useEffect, useState } from 'react'
import { Square } from 'lucide-react'
import { Button, ConfirmDialog } from '@/shared/ui'
import { executionController, type ExecutionController } from '../controller/executionController'
import { useExecutionSnapshot } from '../hooks/useExecutionController'
import {
  formatExecutionElapsed,
  readActiveExecutionView,
  stopActiveExecutionRun,
} from '../model/activeRunDisplay'

const ELAPSED_TICK_INTERVAL_MS = 1_000

interface ExecutionStatusBarProps {
  /** 仅测试或嵌入式场景注入；缺省使用应用级单例控制器。 */
  controller?: ExecutionController
}

export default function ExecutionStatusBar({ controller = executionController }: ExecutionStatusBarProps) {
  const state = useExecutionSnapshot(controller)
  const view = readActiveExecutionView(state)
  // 记录确认框为哪个 run 而打开：run 变化或消失时确认框随之失效，不需要额外的重置副作用。
  const [confirmRunId, setConfirmRunId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const startedAt = view?.startedAt ?? null

  // 已用时按秒推进：run 出现/切换后先对齐一次当前时刻，再按固定间隔走秒；
  // 没有起始时间的 Run 不显示计时，也不启动定时器。
  useEffect(() => {
    if (startedAt === null) return undefined
    const tick = () => setNow(Date.now())
    const alignTimer = window.setTimeout(tick, 0)
    const timer = window.setInterval(tick, ELAPSED_TICK_INTERVAL_MS)
    return () => {
      window.clearTimeout(alignTimer)
      window.clearInterval(timer)
    }
  }, [startedAt])

  if (!view) return null

  const confirmOpen = confirmRunId !== null && confirmRunId === view.runId
  const elapsed = startedAt === null ? null : formatExecutionElapsed(Math.max(0, now - startedAt))
  const summary = view.currentEntry ?? view.message

  return (
    <section className="la-pluma-execution-bar" aria-label="执行状态">
      <div className="la-pluma-execution-bar-surface" title={view.message ?? undefined}>
        <span className="la-pluma-execution-bar-dot" aria-hidden="true" />
        <div className="la-pluma-execution-bar-copy">
          <span className="la-pluma-execution-bar-title">{view.title}</span>
          {summary && <span className="la-pluma-execution-bar-entry">{summary}</span>}
          {view.phaseLabel && <span className="la-pluma-execution-bar-phase">{view.phaseLabel}</span>}
          {elapsed && <span className="la-pluma-execution-bar-time">已用时 {elapsed}</span>}
        </div>
        <Button
          variant="danger"
          size="sm"
          onClick={() => setConfirmRunId(view.runId)}
          disabled={view.isStopping}
          loading={view.isStopping}
          loadingText="正在终止"
          icon={!view.isStopping ? <Square size={12} fill="currentColor" aria-hidden="true" /> : undefined}
          className="la-pluma-execution-bar-stop"
        >
          终止执行
        </Button>
      </div>
      <ConfirmDialog
        isOpen={confirmOpen}
        onClose={() => setConfirmRunId(null)}
        onConfirm={() => stopActiveExecutionRun(controller, view.runId)}
        title="终止当前执行？"
        message="将请求服务端停止正在运行的任务；停止请求可以安全重试，发送后需等待任务进入终态。"
        confirmText="确认终止"
        variant="danger"
      />
    </section>
  )
}
