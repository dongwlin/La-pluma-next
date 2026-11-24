import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useExecutionSnapshot } from '@/features/task-execution'
import { ConfirmAlertDialog } from '@/shared/components'
import {
  dismissNotice,
  LOGS_COVERAGE_NOTICE_ID,
  LOGS_HIDDEN_MATCHES_NOTICE_ID,
  LOGS_NOTICE_ID,
  LOGS_REFRESH_NOTICE_ID,
  notify,
} from '@/shared/notifications'
import { useLogsSession } from '../hooks/useLogsSession'
import {
  buildLogView,
  filterLogsByRunId,
  type LogEventFilter,
  type LogFilter,
} from '../model/logModel'
import { buildLogExportFileName, formatLogExport } from '../model/logExport'
import type { LogFile } from '../types'
import HistoryLogPicker from './HistoryLogPicker'
import LogConsole from './LogConsole'
import LogsToolbar from './LogsToolbar'

export default function LogsWorkspace() {
  const session = useLogsSession()
  const { history, realtime } = session
  const execution = useExecutionSnapshot()
  const [autoScroll, setAutoScroll] = useState(true)
  const [runId, setRunId] = useState('')
  const [events, setEvents] = useState<LogEventFilter>('key')
  const [clearVersion, setClearVersion] = useState(0)
  const [filter, setFilter] = useState<LogFilter>('all')
  const [search, setSearch] = useState('')
  const [collapseRepeats, setCollapseRepeats] = useState(true)
  const [confirmCleanup, setConfirmCleanup] = useState(false)
  const refreshErrorRef = useRef<string | null>(null)
  const viewingHistory = history.viewing
  const logs = viewingHistory ? history.logs : realtime.logs
  const loading = history.readPhase === 'loading'
  const actionBusy = session.commandPending !== null
  const activeError = viewingHistory ? history.error : realtime.error

  const knownRunIds = useMemo(() => Array.from(new Set([
    ...(runId ? [runId] : []),
    ...(execution.trackedRun ? [execution.trackedRun.runId] : []),
    ...realtime.logs.flatMap(log => log.runId ? [log.runId] : []),
  ])), [execution.trackedRun, realtime.logs, runId])
  const runFilteredLogs = useMemo(
    () => filterLogsByRunId(logs, viewingHistory ? null : runId || null),
    [logs, runId, viewingHistory],
  )

  const logView = useMemo(() => buildLogView(runFilteredLogs, {
    events,
    level: filter,
    search,
    collapseRepeats,
  }), [collapseRepeats, events, filter, runFilteredLogs, search])

  const retryActiveLogs = useCallback(() => {
    if (viewingHistory) {
      if (history.selectedFile) history.retry()
      return
    }
    if (realtime.paused) realtime.resume()
    else realtime.refresh()
  }, [history, realtime, viewingHistory])

  useEffect(() => {
    if (realtime.coverageNotice) {
      notify(realtime.coverageNotice, 'warning', {
        id: LOGS_COVERAGE_NOTICE_ID,
        duration: Infinity,
      })
      return
    }
    dismissNotice(LOGS_COVERAGE_NOTICE_ID)
  }, [realtime.coverageNotice])

  useEffect(() => {
    if (logView.hiddenMatchCount > 0) {
      notify(`${logView.hiddenMatchCount} 条匹配日志被关键事件筛选隐藏`, 'info', {
        id: LOGS_HIDDEN_MATCHES_NOTICE_ID,
        action: { label: '显示全部事件', onClick: () => setEvents('all') },
      })
      return
    }
    dismissNotice(LOGS_HIDDEN_MATCHES_NOTICE_ID)
  }, [logView.hiddenMatchCount])

  useEffect(() => {
    const refreshError = !viewingHistory && realtime.logs.length > 0 ? realtime.error : null
    if (!refreshError) {
      if (refreshErrorRef.current !== null) {
        refreshErrorRef.current = null
        dismissNotice(LOGS_REFRESH_NOTICE_ID)
      }
      return
    }
    if (refreshErrorRef.current === refreshError) return
    refreshErrorRef.current = refreshError
    notify(refreshError, 'error', {
      id: LOGS_REFRESH_NOTICE_ID,
      duration: Infinity,
      action: { label: '重试', onClick: retryActiveLogs },
    })
  }, [realtime.error, realtime.logs.length, retryActiveLogs, viewingHistory])

  useEffect(() => () => {
    dismissNotice(LOGS_COVERAGE_NOTICE_ID)
    dismissNotice(LOGS_HIDDEN_MATCHES_NOTICE_ID)
    dismissNotice(LOGS_REFRESH_NOTICE_ID)
  }, [])

  const viewHistoryFile = (file: LogFile) => {
    setAutoScroll(false)
    session.enterHistory(file)
  }

  const backToRealtime = () => {
    setAutoScroll(true)
    session.backToRealtime()
  }

  const clearLogs = () => {
    if (viewingHistory) return
    realtime.clear()
    setClearVersion(value => value + 1)
    notify('已清屏，后续到达的日志会继续显示', 'success', { id: LOGS_NOTICE_ID })
  }

  const cleanupHistoryLogs = async () => {
    const outcome = await session.cleanupHistoryLogs()
    if (outcome.status === 'succeeded') {
      notify(outcome.message, 'success', { id: LOGS_NOTICE_ID })
      return true
    }
    if (outcome.status === 'failed') {
      throw new Error(outcome.message)
    }
    return false
  }

  const exportLogs = () => {
    const logText = formatLogExport(logView.selected)
    const blob = new Blob([logText], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = buildLogExportFileName(new Date())
    anchor.click()
    URL.revokeObjectURL(url)
    notify(`已导出 ${logView.selected.length} 条日志（当前筛选）`, 'success', {
      id: LOGS_NOTICE_ID,
    })
  }

  const togglePause = () => {
    if (realtime.paused) realtime.resume()
    else realtime.pause()
  }

  return (
    <>
      <LogsToolbar
        autoScroll={autoScroll}
        onAutoScrollChange={setAutoScroll}
        runId={runId}
        runIds={knownRunIds}
        onRunIdChange={setRunId}
        events={events}
        onEventsChange={setEvents}
        collapseRepeats={collapseRepeats}
        onCollapseRepeatsChange={setCollapseRepeats}
        filter={filter}
        onFilterChange={setFilter}
        search={search}
        onSearchChange={setSearch}
        viewingHistory={viewingHistory}
        paused={realtime.paused}
        onTogglePause={togglePause}
        actionBusy={actionBusy}
        canExport={logView.selected.length > 0}
        onClear={clearLogs}
        onExport={exportLogs}
      />

      {viewingHistory && (
        <p className="log-coverage">历史文件显示已加载的尾部内容；导出仅包含当前筛选结果。</p>
      )}

      <LogConsole
        viewingHistory={viewingHistory}
        selectedFile={history.selectedFile}
        loading={loading}
        error={activeError}
        logs={runFilteredLogs}
        view={logView}
        autoScroll={autoScroll}
        paused={realtime.paused}
        onRetry={retryActiveLogs}
        onBackToRealtime={backToRealtime}
        scopeKey={JSON.stringify([viewingHistory ? history.selectedFile?.path : runId, events, filter, search, clearVersion])}
      />

      <HistoryLogPicker
        files={history.files}
        filesError={history.filesError}
        selectedFile={history.selectedFile}
        cleanupDisabled={actionBusy || history.files.length === 0 || viewingHistory}
        onSelect={viewHistoryFile}
        onCleanup={() => setConfirmCleanup(true)}
        onReload={() => void history.reloadFiles()}
      />

      <ConfirmAlertDialog
        isOpen={confirmCleanup}
        onClose={() => setConfirmCleanup(false)}
        onConfirm={cleanupHistoryLogs}
        title="清理旧日志文件？"
        message="系统会删除较旧的日志文件，只保留最新的 10 MB。此操作无法撤销。"
        confirmText="确认清理"
        variant="danger"
      />
    </>
  )
}
