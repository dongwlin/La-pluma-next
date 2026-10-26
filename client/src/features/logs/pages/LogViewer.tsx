import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Download,
  FileText,
  List,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import {
  PageHeader,
  Card,
  CardHeader,
  CardContent,
  Button,
  IconButton,
  Select,
  Input,
  Loading,
  ConfirmDialog,
  SmoothPanel,
  Switch,
} from '@/shared/ui'
import { FloatingStatusIndicator } from '@/features/runtime-status'
import { useFluidTabIndicator } from '@/shared/hooks/useFluidTabIndicator'
import { buildLogView, type LogContentMode, type LogFilter } from '../model/logModel'
import { useLogsSession } from '../hooks/useLogsSession'
import type { LogFile } from '../types'

type ConfirmAction = 'clear' | 'cleanup'
type Notice = { type: 'success' | 'error'; text: string }

const CONTENT_MODE_OPTIONS: ReadonlyArray<{ id: LogContentMode; label: string; description: string }> = [
  { id: 'summary', label: '摘要', description: '关键事件' },
  { id: 'raw', label: '原始', description: '完整内容' },
]

export default function LogViewer() {
  const shouldReduceMotion = useReducedMotion()
  const session = useLogsSession()
  const { history, realtime } = session
  const [autoScroll, setAutoScroll] = useState(true)
  const [contentMode, setContentMode] = useState<LogContentMode>('summary')
  const [filter, setFilter] = useState<LogFilter>('all')
  const [search, setSearch] = useState('')
  const [collapseRepeats, setCollapseRepeats] = useState(true)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)
  const viewingHistory = history.viewing
  const historyLogs = history.logs
  const historyFiles = history.files
  const selectedFile = history.selectedFile
  const loading = history.readPhase === 'loading'
  const historyError = history.error
  const actionBusy = session.commandPending !== null
  const logs = viewingHistory ? historyLogs : realtime.logs
  const {
    containerRef: contentModeTabsRef,
    activeRect: activeContentModeRect,
    setTabRef: setContentModeTabRef,
    handleTabKeyDown: handleContentModeKeyDown,
  } = useFluidTabIndicator(contentMode)
  const logContainerRef = useRef<HTMLDivElement>(null)

  const viewHistoryFile = (file: LogFile) => {
    setAutoScroll(false)
    session.enterHistory(file)
  }

  const backToRealtime = () => {
    setAutoScroll(true)
    session.backToRealtime()
  }

  useEffect(() => {
    if (autoScroll && !viewingHistory && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
    }
  }, [logs, autoScroll, viewingHistory])

  const logView = useMemo(() => buildLogView(logs, {
    mode: contentMode,
    level: filter,
    search,
    collapseRepeats,
  }), [collapseRepeats, contentMode, filter, logs, search])
  const filteredLogs = logView.filtered
  const visibleLogs = logView.visible

  const clearLogs = async () => {
    if (viewingHistory) return false
    setNotice(null)
    const outcome = await session.clearRealtimeLogs()
    if (outcome.status === 'succeeded') {
      setNotice({ type: 'success', text: outcome.message })
      return true
    }
    if (outcome.status === 'failed') {
      setNotice({ type: 'error', text: outcome.message })
      throw new Error(outcome.message)
    }
    return false
  }

  const cleanupHistoryLogs = async () => {
    setNotice(null)
    const outcome = await session.cleanupHistoryLogs()
    if (outcome.status === 'succeeded') {
      setNotice({ type: 'success', text: outcome.message })
      return true
    }
    if (outcome.status === 'failed') {
      setNotice({ type: 'error', text: outcome.message })
      throw new Error(outcome.message)
    }
    return false
  }

  const handleConfirm = async () => {
    if (confirmAction === 'clear') return clearLogs()
    if (confirmAction === 'cleanup') return cleanupHistoryLogs()
    return false
  }

  const exportLogs = () => {
    const logText = filteredLogs.map(log => `[${log.time}] [${log.level}] ${log.message}`).join('\n')
    const blob = new Blob([logText], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `maa-log-${new Date().toISOString().split('T')[0]}.txt`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const activeError = viewingHistory ? historyError : realtime.error
  const isSummaryEmpty = logs.length > 0 && logView.readable.length === 0
  const isFilteredEmpty = logView.readable.length > 0 && visibleLogs.length === 0
  const retryActiveLogs = () => {
    if (viewingHistory && selectedFile) history.retry()
    else realtime.refresh()
  }

  return (
    <div className="app-page log-viewer ios-workspace-page ios-borderless-cards">
      <div className="app-stack-section">
        <PageHeader
          title="日志"
          subtitle="实时查看任务执行与历史记录"
          mobileLayout="inline"
          actions={<FloatingStatusIndicator />}
        />

        {notice && (
          <SmoothPanel
            cornerSize="compact"
            surfaceClassName={`log-notice ${notice.type === 'error' ? 'is-error' : 'is-success'}`}
            role={notice.type === 'error' ? 'alert' : 'status'}
            aria-live={notice.type === 'error' ? 'assertive' : 'polite'}
          >
            {notice.type === 'error'
              ? <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              : <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />}
            <span>{notice.text}</span>
            <IconButton
              icon={<X className="h-4 w-4" aria-hidden="true" />}
              onClick={() => setNotice(null)}
              variant="ghost"
              size="sm"
              title="关闭提示"
              aria-label="关闭提示"
            />
          </SmoothPanel>
        )}

        <div className="app-workspace-segments app-liquid-tab-pill log-mode-shell">
          <div
            ref={contentModeTabsRef}
            className="app-workspace-segment-list log-mode-tabs"
            role="tablist"
            aria-label="日志内容模式"
          >
            {activeContentModeRect.width > 0 && (
              <motion.div
                data-testid="log-mode-highlight"
                aria-hidden="true"
                className="app-workspace-segment-indicator log-mode-highlight"
                initial={false}
                animate={{
                  x: activeContentModeRect.x,
                  y: activeContentModeRect.y,
                  width: activeContentModeRect.width,
                  height: activeContentModeRect.height,
                }}
                transition={shouldReduceMotion
                  ? { duration: 0 }
                  : { type: 'spring', stiffness: 420, damping: 38, mass: 0.72 }}
              />
            )}
            {CONTENT_MODE_OPTIONS.map(option => {
              const selected = contentMode === option.id
              const ModeIcon = option.id === 'summary' ? List : FileText
              return (
                <button
                  key={option.id}
                  ref={setContentModeTabRef(option.id)}
                  type="button"
                  role="tab"
                  onClick={() => setContentMode(option.id)}
                  onKeyDown={event => handleContentModeKeyDown(
                    event,
                    CONTENT_MODE_OPTIONS.map(({ id }) => id),
                    setContentMode,
                  )}
                  aria-selected={selected}
                  aria-controls="log-console-panel"
                  tabIndex={selected ? 0 : -1}
                  className={`app-workspace-segment log-mode-button min-h-11 ${selected ? 'is-selected' : ''}`}
                >
                  <span className="app-workspace-segment-icon log-mode-icon" aria-hidden="true">
                    <ModeIcon />
                  </span>
                  <span className="app-workspace-segment-copy">
                    <span>{option.label}</span>
                    <small>{option.description}</small>
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        <Card className="log-card log-toolbar-card p-0!" smoothCorners>
          <CardContent className="log-toolbar">
            <div className="log-toolbar-controls">
              <div className={`log-toggle-control flex min-h-11 min-w-0 items-center justify-between gap-3 ${viewingHistory ? 'opacity-50' : ''}`}>
                <span className="truncate text-xs font-medium text-secondary">自动滚动</span>
                <Switch
                  compact
                  checked={autoScroll}
                  onChange={setAutoScroll}
                  label="自动滚动"
                  disabled={viewingHistory}
                />
              </div>
              <div className="log-toggle-control flex min-h-11 min-w-0 items-center justify-between gap-3">
                <span className="truncate text-xs font-medium text-secondary">折叠重复</span>
                <Switch
                  compact
                  checked={collapseRepeats}
                  onChange={setCollapseRepeats}
                  label="折叠重复日志"
                />
              </div>
              <Select
                value={filter}
                onChange={value => setFilter(value as LogFilter)}
                aria-label="日志级别"
                className="col-span-2 w-full sm:col-auto sm:w-36"
                options={[
                  { value: 'all', label: '全部级别' },
                  { value: 'ERROR', label: '错误' },
                  { value: 'WARN', label: '警告' },
                  { value: 'INFO', label: '信息' },
                  { value: 'DEBUG', label: '调试' },
                ]}
              />
              <Input
                value={search}
                onChange={setSearch}
                placeholder="搜索日志内容"
                aria-label="搜索日志内容"
                icon={<Search className="h-4 w-4" aria-hidden="true" />}
                className="col-span-2 w-full sm:col-auto sm:min-w-56 sm:flex-1"
              />
            </div>
            <div className="log-toolbar-actions">
              {!viewingHistory && (
                <Button
                  onClick={() => setConfirmAction('clear')}
                  variant="outline"
                  size="sm"
                  icon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
                  disabled={actionBusy}
                >
                  清空
                </Button>
              )}
              <Button
                onClick={exportLogs}
                variant="primary"
                size="sm"
                icon={<Download className="h-4 w-4" aria-hidden="true" />}
                disabled={filteredLogs.length === 0}
              >
                导出
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="log-card min-w-0 p-0!" smoothCorners>
          <CardHeader
            title={viewingHistory ? '历史日志' : '实时日志'}
            actions={
              <div className="log-console-heading-actions">
                <span className="log-count">{visibleLogs.length} 条</span>
                {viewingHistory && (
                  <Button
                    onClick={backToRealtime}
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
                ref={logContainerRef}
                className="log-console"
                role="log"
                aria-label="日志内容"
                aria-live="polite"
                aria-relevant="additions text"
              >
                {activeError && (
                  <div
                    className={`log-console-state is-error flex-wrap ${logs.length > 0 ? 'status-danger m-3 min-h-0! justify-start! p-3! text-left font-sans text-sm' : ''}`}
                    role="alert"
                  >
                    <AlertCircle className="h-5 w-5" aria-hidden="true" />
                    <span>{activeError}</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={retryActiveLogs}
                    >
                      重新加载
                    </Button>
                  </div>
                )}
                {!activeError && logs.length === 0 && (
                  <div className="log-console-state">
                    <FileText className="h-5 w-5" aria-hidden="true" />
                    <span>{viewingHistory ? '这个日志文件没有内容' : '暂无实时日志，等待任务执行'}</span>
                  </div>
                )}
                {!activeError && isSummaryEmpty && (
                  <div className="log-console-state">
                    <FileText className="h-5 w-5" aria-hidden="true" />
                    <span>当前日志没有需要关注的事件</span>
                  </div>
                )}
                {!activeError && isFilteredEmpty && (
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
                      {collapseRepeats && log.count > 1 && <span className="log-repeat">x{log.count}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="log-card log-history-card min-w-0 p-0!" smoothCorners>
          <CardHeader
            title="历史日志文件"
            actions={
              <div className="log-console-heading-actions">
                <span className="log-count hidden sm:inline-flex">{historyFiles.length} 个</span>
                <Button
                  onClick={() => setConfirmAction('cleanup')}
                  variant="outline"
                  size="sm"
                  icon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
                  disabled={actionBusy || historyFiles.length === 0 || viewingHistory}
                >
                  清理旧日志
                </Button>
              </div>
            }
          />
          <CardContent className="log-history-content">
            {history.filesError && (
              <div className="log-history-state is-error flex-wrap px-4 py-6" role="alert">
                <AlertCircle className="h-5 w-5" aria-hidden="true" />
                <span>{history.filesError}</span>
                <Button type="button" variant="outline" size="sm" onClick={() => void history.reloadFiles()}>
                  重新加载
                </Button>
              </div>
            )}
            {!history.filesError && historyFiles.length === 0 && (
              <div className="log-history-state">
                <FileText className="h-5 w-5" aria-hidden="true" />
                <div>
                  <p>暂无历史日志文件</p>
                  <span>执行任务后会自动生成</span>
                </div>
              </div>
            )}
            {!history.filesError && historyFiles.length > 0 && (
              <div className="log-history-list">
                {historyFiles.map(file => (
                  <button
                    type="button"
                    key={file.path}
                    onClick={() => viewHistoryFile(file)}
                    className={`log-history-row ${selectedFile?.path === file.path ? 'is-active' : ''}`}
                    aria-current={selectedFile?.path === file.path ? 'true' : undefined}
                  >
                    <span className="log-history-icon"><FileText className="h-4 w-4" aria-hidden="true" /></span>
                    <span className="log-history-copy">
                      <strong title={file.name}>{file.name}</strong>
                      <small>{new Date(file.modified).toLocaleString('zh-CN')} · {(file.size / 1024).toFixed(2)} KB</small>
                    </span>
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <ConfirmDialog
          isOpen={confirmAction !== null}
          onClose={() => setConfirmAction(null)}
          onConfirm={handleConfirm}
          title={confirmAction === 'clear' ? '清空实时日志？' : '清理旧日志文件？'}
          message={confirmAction === 'clear'
            ? '这会清空当前会话中的实时日志缓存，历史日志文件不会受到影响。'
            : '系统会删除较旧的日志文件，只保留最新的 10 MB。此操作无法撤销。'}
          confirmText={confirmAction === 'clear' ? '确认清空' : '确认清理'}
          variant="danger"
        />
      </div>
    </div>
  )
}
