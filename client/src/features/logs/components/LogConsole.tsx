/**
 * 日志控制台列表
 *
 * 列表展示、空态/失败态、选中历史文件信息与滚动跟随都靠近滚动容器：
 * - 接收工作区已派生的 `LogView`，不重新过滤或折叠；
 * - 详细模式下被改写的行带 `raw` 原始消息，渲染为可展开的「原始内容」
 *   详情，回调行的 JSON 段由 `formatLogRawDetail` 缩进展示；
 * - 拥有滚动容器引用与滚动 Effect：Effect 依赖内容指纹（行数+末行时间+
 *   末行文本），轮询造成的纯引用变化不再触发滚动；手动「自动滚动」开关
 *   关闭=永不跟随；
 * - 智能跟随是开关内的第二层：用户离开底部即临时暂停，暂停期间新增行累计
 *   为未读数并显示「↓ N 条新日志」指示，回到底部或点击指示恢复并清零；
 *   状态裁决归 `model/logFollow.ts`，本组件只采集滚动事件与快照差值；
 * - 失败重试与返回实时只回调，不直接调用会话所有者；
 * - `variant="run-mini"` 是工作区内嵌的「本次执行日志」迷你控制台：标题、
 *   空态文案与紧凑高度由变体固定，收起按钮只在提供 `onCollapse` 时出现。
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { AlertCircle, ArrowDown, ArrowLeft, ChevronDown, FileText, Search } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, Loading } from '@/shared/ui'
import { countAppendedRows, initialLogFollowState, reduceLogFollow } from '../model/logFollow'
import { buildLogContentFingerprint, formatLogRawDetail, type LogView } from '../model/logModel'
import type { LogEntry, LogFile } from '../types'

/** 距底部小于该值视为仍在底部，吸收取整与吸附误差。 */
const FOLLOW_BOTTOM_GAP_PX = 4

/** 展示变体：default 为日志页控制台；run-mini 为工作区内嵌的本次执行迷你控制台。 */
export type LogConsoleVariant = 'default' | 'run-mini'

interface LogConsoleProps {
  readonly viewingHistory: boolean
  readonly selectedFile: LogFile | null
  readonly loading: boolean
  readonly error: string | null
  readonly logs: readonly LogEntry[]
  readonly view: LogView
  readonly autoScroll: boolean
  readonly paused: boolean
  readonly onRetry: () => void
  readonly onBackToRealtime: () => void
  readonly variant?: LogConsoleVariant
  /** 迷你变体的收起回调；提供时在标题行渲染「收起」按钮。 */
  readonly onCollapse?: () => void
}

export default function LogConsole({
  viewingHistory,
  selectedFile,
  loading,
  error,
  logs,
  view,
  autoScroll,
  paused,
  onRetry,
  onBackToRealtime,
  variant = 'default',
  onCollapse,
}: LogConsoleProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [follow, dispatchFollow] = useReducer(reduceLogFollow, initialLogFollowState)
  const followEligible = autoScroll && !viewingHistory
  const isRunMini = variant === 'run-mini'
  const headingTitle = isRunMini
    ? '本次执行日志'
    : viewingHistory ? '历史日志' : '实时日志'

  const logsFingerprint = useMemo(() => buildLogContentFingerprint(logs), [logs])

  // 智能跟随的开关边界：开关翻转或进出历史时无条件回到跟随状态，不让暂停
  // 计数跨场景残留。
  useEffect(() => {
    dispatchFollow({ type: 'reset' })
  }, [followEligible])

  const handleContainerScroll = useCallback(() => {
    const node = containerRef.current
    if (!node) return
    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    dispatchFollow({
      type: distanceToBottom <= FOLLOW_BOTTOM_GAP_PX ? 'reach-bottom' : 'leave-bottom',
    })
  }, [])

  // 只在开关打开的实时模式监听用户滚动；暂停期间保持监听以检测回到底部。
  useEffect(() => {
    if (!followEligible) return
    const node = containerRef.current
    if (!node) return
    node.addEventListener('scroll', handleContainerScroll)
    return () => node.removeEventListener('scroll', handleContainerScroll)
  }, [followEligible, handleContainerScroll])

  // 内容变化时把新增行交给状态机；跟随中状态机会忽略。先按引用排除内容
  // 未变的提交，新增行数按相邻两次内容变化的行数差推导。
  const previousLogsRef = useRef(logs)
  useEffect(() => {
    const previous = previousLogsRef.current
    previousLogsRef.current = logs
    if (previous === logs) return
    dispatchFollow({ type: 'append', count: countAppendedRows(previous, logs) })
  }, [logs])

  // 跟随 Effect 依赖内容指纹：内容不变时引用变化不再滚动，智能暂停时不与
  // 用户抢滚动位置。
  useEffect(() => {
    if (!followEligible || follow.paused) return
    const node = containerRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [followEligible, follow.paused, logsFingerprint])

  const resumeFollow = useCallback(() => {
    const node = containerRef.current
    if (node) node.scrollTop = node.scrollHeight
    dispatchFollow({ type: 'reach-bottom' })
  }, [])

  const visibleLogs = view.visible
  const isSummaryEmpty = logs.length > 0 && view.readable.length === 0
  const isFilteredEmpty = view.readable.length > 0 && visibleLogs.length === 0

  return (
    <Card className="log-card min-w-0 p-0!" smoothCorners>
      <CardHeader
        title={headingTitle}
        actions={
          <div className="log-console-heading-actions">
            <span className="log-count">{visibleLogs.length} 条</span>
            {isRunMini && (
              <Button
                onClick={onCollapse}
                variant="outline"
                size="sm"
                icon={<ChevronDown className="h-4 w-4" aria-hidden="true" />}
              >
                收起
              </Button>
            )}
            {viewingHistory && (
              <Button
                onClick={onBackToRealtime}
                variant="outline"
                size="sm"
                icon={<ArrowLeft className="h-4 w-4" aria-hidden="true" />}
              >
                返回实时
              </Button>
            )}
          </div>
        }
      />
      <CardContent className="log-console-content">
        {viewingHistory && selectedFile && (
          <div className="surface-soft mb-3 flex min-w-0 items-center gap-2 rounded-xl px-3 py-2 text-xs text-secondary">
            <FileText className="h-4 w-4 shrink-0 text-tertiary" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-medium text-primary" title={selectedFile.name}>
              {selectedFile.name}
            </span>
            <span className="hidden shrink-0 text-tertiary sm:inline">
              {(selectedFile.size / 1024).toFixed(2)} KB
            </span>
          </div>
        )}
        {loading ? (
          <div id="log-console-panel" className="log-console" aria-busy="true">
            <div className="flex min-h-full items-center justify-center font-sans">
              <Loading text="正在读取日志..." />
            </div>
          </div>
        ) : (
          <div className="relative">
            <div
              id="log-console-panel"
              ref={containerRef}
              className={`log-console ${isRunMini ? 'is-mini' : ''}`}
              role="log"
              aria-label="日志内容"
              aria-live="polite"
              aria-relevant="additions text"
            >
              {error && (
                <div
                  className={`log-console-state is-error flex-wrap ${logs.length > 0 ? 'status-danger m-3 min-h-0! justify-start! p-3! text-left font-sans text-sm' : ''}`}
                  role="alert"
                >
                  <AlertCircle className="h-5 w-5" aria-hidden="true" />
                  <span>{error}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onRetry}
                  >
                    重新加载
                  </Button>
                </div>
              )}
              {!error && logs.length === 0 && (
                <div className="log-console-state">
                  <FileText className="h-5 w-5" aria-hidden="true" />
                  <span>
                    {isRunMini
                      ? '本次执行还没有日志'
                      : viewingHistory
                        ? '这个日志文件没有内容'
                        : paused
                          ? '实时日志已暂停，继续后重新读取'
                          : '暂无实时日志，等待任务执行'}
                  </span>
                </div>
              )}
              {!error && isSummaryEmpty && (
                <div className="log-console-state">
                  <FileText className="h-5 w-5" aria-hidden="true" />
                  <span>当前日志没有需要关注的事件</span>
                </div>
              )}
              {!error && isFilteredEmpty && (
                <div className="log-console-state">
                  <Search className="h-5 w-5" aria-hidden="true" />
                  <span>没有符合当前筛选条件的日志</span>
                </div>
              )}
              {visibleLogs.map((log, index) => (
                <div className="log-row" key={`${log.time}-${log.level}-${log.message}-${index}`}>
                  <div className="log-row-meta">
                    {log.time && <time>{log.time}</time>}
                    <span className={`log-level is-${log.level.toLowerCase()}`}>{log.level}</span>
                  </div>
                  <div className="log-message">
                    <span>{log.message}</span>
                    {log.count > 1 && <span className="log-repeat">x{log.count}</span>}
                    {log.raw && (
                      <details className="log-raw">
                        <summary>原始内容</summary>
                        <pre>{formatLogRawDetail(log.raw)}</pre>
                      </details>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {followEligible && follow.paused && (
              <Button
                type="button"
                variant="primary"
                size="sm"
                className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 shadow-lg"
                icon={<ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />}
                onClick={resumeFollow}
              >
                {follow.pendingCount > 0 ? `${follow.pendingCount} 条新日志` : '回到底部'}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
