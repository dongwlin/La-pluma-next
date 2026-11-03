/** 日志页是日志观察的唯一工作区；范围、事件选择与内容呈现各自独立。 */

import { useMemo, useState } from 'react'
import { useExecutionSnapshot } from '@/features/task-execution'
import { ConfirmDialog } from '@/shared/ui'
import { useLogsSession } from '../hooks/useLogsSession'
import {
  buildLogView,
  filterLogsByRunId,
  type LogContentMode,
  type LogEventFilter,
  type LogFilter,
} from '../model/logModel'
import { buildLogExportFileName, formatLogExport } from '../model/logExport'
import type { LogFile } from '../types'
import HistoryLogPicker from './HistoryLogPicker'
import LogConsole from './LogConsole'
import LogContentModeTabs from './LogContentModeTabs'
import LogNotice, { type LogNoticeData } from './LogNotice'
import LogsToolbar from './LogsToolbar'

export default function LogsWorkspace() {
  const session = useLogsSession()
  const { history, realtime } = session
  const execution = useExecutionSnapshot()
  const [autoScroll, setAutoScroll] = useState(true)
  const [contentMode, setContentMode] = useState<LogContentMode>('readable')
  const [runId, setRunId] = useState('')
  const [events, setEvents] = useState<LogEventFilter>('key')
  const [clearVersion, setClearVersion] = useState(0)
  const [filter, setFilter] = useState<LogFilter>('all')
  const [search, setSearch] = useState('')
  const [collapseRepeats, setCollapseRepeats] = useState(true)
  const [notice, setNotice] = useState<LogNoticeData | null>(null)
  const [confirmCleanup, setConfirmCleanup] = useState(false)
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
    mode: contentMode,
    events,
    level: filter,
    search,
    collapseRepeats,
  }), [collapseRepeats, contentMode, events, filter, runFilteredLogs, search])

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
    setNotice({ type: 'success', text: '已清屏，后续到达的日志会继续显示' })
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

  const exportLogs = () => {
    const logText = formatLogExport(logView.selected)
    const blob = new Blob([logText], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = buildLogExportFileName(new Date())
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const retryActiveLogs = () => {
    if (viewingHistory) {
      if (history.selectedFile) history.retry()
      return
    }
    if (realtime.paused) realtime.resume()
    else realtime.refresh()
  }

  const togglePause = () => {
    if (realtime.paused) realtime.resume()
    else realtime.pause()
  }

  return (
    <>
      {notice && (
        <LogNotice
          type={notice.type}
          text={notice.text}
          onDismiss={() => setNotice(null)}
        />
      )}

      <LogContentModeTabs mode={contentMode} onChange={setContentMode} />

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

      <p className="log-coverage">
        {viewingHistory
          ? '历史文件显示已加载的尾部内容；导出仅包含当前筛选结果。'
          : '实时日志显示最近采集窗口；执行早期或暂停期间的记录可能已移出窗口。导出仅包含当前筛选结果。'}
      </p>
      {!viewingHistory && realtime.coverageNotice && (
        <p className="log-coverage" role="status">{realtime.coverageNotice}</p>
      )}
      {logView.hiddenMatchCount > 0 && (
        <div className="log-hidden-matches" role="status">
          <span>{logView.hiddenMatchCount} 条匹配日志被关键事件筛选隐藏</span>
          <button type="button" onClick={() => setEvents('all')}>显示全部事件</button>
        </div>
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

      <ConfirmDialog
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
