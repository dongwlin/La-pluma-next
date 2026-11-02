/**
 * 本次执行日志迷你面板
 *
 * 供自动战斗、肉鸽等工作区内嵌：按传入的当前 runId 过滤实时流（只归属该
 * run 的条目），以易读模式派生视图并交给 `LogConsole` 的 run-mini 变体渲染。
 * 语义摘要、run 过滤、重复折叠与滚动跟随都复用日志域模型与控制台，这里只
 * 负责三件事：
 * - 折叠壳：默认折叠，折叠态只渲染「查看本次日志」入口，不订阅实时流；
 * - 展开时创建页面自己的实时流实例（轮询启停跟随折叠态），不复用日志页
 *   的会话，也不清空彼此的缓冲；
 * - runId 为空（当前没有本域跟踪的 run）时整块隐藏。
 *
 * 折叠态由工作区持有，便于「本次执行进度」等外部入口直接展开。
 */

import { useMemo } from 'react'
import { ScrollText } from 'lucide-react'
import { Button } from '@/shared/ui'
import { useRealtimeLogs } from '../hooks/useRealtimeLogs'
import { buildLogView, filterLogsByRunId } from '../model/logModel'
import type { RealtimeLogStream } from '../model/realtimeLogStream'
import LogConsole from './LogConsole'

interface CurrentRunLogPanelProps {
  /** 当前被跟踪 run 的 runId；null 时面板整块隐藏。 */
  readonly runId: string | null
  /** 折叠态由工作区持有：默认折叠，外部入口可以直接展开。 */
  readonly open: boolean
  readonly onToggle: () => void
  /** 使用方布局类（如肉鸽工作区的 grid area）。 */
  readonly className?: string
  /** 测试或特殊场景注入的流实例；省略时挂载创建独立实例。 */
  readonly stream?: RealtimeLogStream
}

export default function CurrentRunLogPanel({
  runId,
  open,
  onToggle,
  className,
  stream,
}: CurrentRunLogPanelProps) {
  const realtime = useRealtimeLogs({ enabled: open && Boolean(runId), stream })

  const runLogs = useMemo(
    () => filterLogsByRunId(realtime.logs, runId),
    [realtime.logs, runId],
  )
  const logView = useMemo(() => buildLogView(runLogs, {
    mode: 'readable',
    level: 'all',
    search: '',
    collapseRepeats: true,
  }), [runLogs])

  if (!runId) return null

  return (
    <section className={className} aria-label="本次执行日志">
      {open ? (
        <LogConsole
          variant="run-mini"
          viewingHistory={false}
          selectedFile={null}
          loading={false}
          error={realtime.error}
          logs={runLogs}
          view={logView}
          autoScroll
          paused={realtime.paused}
          onRetry={realtime.refresh}
          onBackToRealtime={() => {}}
          onCollapse={onToggle}
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onToggle}
          aria-expanded={false}
          icon={<ScrollText className="h-4 w-4" aria-hidden="true" />}
        >
          查看本次日志
        </Button>
      )}
    </section>
  )
}
