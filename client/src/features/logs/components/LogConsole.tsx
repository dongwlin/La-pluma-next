/**
 * 日志控制台列表
 *
 * 列表展示、空态/失败态、选中历史文件信息与自滚动都靠近滚动容器：
 * - 接收工作区已派生的 `LogView`，不重新过滤或折叠；
 * - 拥有滚动容器引用与 `scrollTop` Effect，仅在实时模式且开关打开时滚到
 *   底部；
 * - 失败重试与返回实时只回调，不直接调用会话所有者。
 */

import { useEffect, useRef } from 'react'
import { AlertCircle, ArrowLeft, FileText, Search } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, Loading } from '@/shared/ui'
import type { LogView } from '../model/logModel'
import type { LogEntry, LogFile } from '../types'

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
}: LogConsoleProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (autoScroll && !viewingHistory && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [autoScroll, logs, viewingHistory])

  const visibleLogs = view.visible
  const isSummaryEmpty = logs.length > 0 && view.readable.length === 0
  const isFilteredEmpty = view.readable.length > 0 && visibleLogs.length === 0

  return (
    <Card className="log-card min-w-0 p-0!" smoothCorners>
      <CardHeader
        title={viewingHistory ? '历史日志' : '实时日志'}
        actions={
          <div className="log-console-heading-actions">
            <span className="log-count">{visibleLogs.length} 条</span>
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
          <div
            id="log-console-panel"
            ref={containerRef}
            className="log-console"
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
                  {viewingHistory
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
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
