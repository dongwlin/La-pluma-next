/**
 * 日志工作区
 *
 * 页面唯一的日志领域容器：组合实时流、历史会话与清空/清理命令，并持有
 * 跨面板共享的纯视图状态：
 * - `contentMode`/`filter`/`search`/`collapseRepeats` 同时影响列表与导出；
 * - `autoScroll` 由工具栏开关、进入历史（关闭）与返回实时（打开）驱动，
 *   scrollTop Effect 靠近 `LogConsole` 的滚动容器；
 * - `notice`/`confirmAction` 只服务命令反馈与确认弹层；
 * - 导出读取 `logView.filtered`（折叠前），文本与文件名格式由
 *   `model/logExport.ts` 固定。
 *
 * 工具栏、控制台与历史选择器都是受控展示组件：不订阅会话、不发请求、不
 * 持有历史选择。暂停只作用于实时轮询；返回实时会恢复被手动暂停的流，
 * 因为进入历史已清空实时缓冲。
 */

import { useMemo, useState } from 'react'
import { ConfirmDialog } from '@/shared/ui'
import { useLogsSession } from '../hooks/useLogsSession'
import { buildLogView, type LogContentMode, type LogFilter } from '../model/logModel'
import { buildLogExportFileName, formatLogExport } from '../model/logExport'
import type { LogFile } from '../types'
import HistoryLogPicker from './HistoryLogPicker'
import LogConsole from './LogConsole'
import LogContentModeTabs from './LogContentModeTabs'
import LogNotice, { type LogNoticeData } from './LogNotice'
import LogsToolbar from './LogsToolbar'

type ConfirmAction = 'clear' | 'cleanup'

export default function LogsWorkspace() {
  const session = useLogsSession()
  const { history, realtime } = session
  const [autoScroll, setAutoScroll] = useState(true)
  const [contentMode, setContentMode] = useState<LogContentMode>('summary')
  const [filter, setFilter] = useState<LogFilter>('all')
  const [search, setSearch] = useState('')
  const [collapseRepeats, setCollapseRepeats] = useState(true)
  const [notice, setNotice] = useState<LogNoticeData | null>(null)
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)
  const viewingHistory = history.viewing
  const logs = viewingHistory ? history.logs : realtime.logs
  const loading = history.readPhase === 'loading'
  const actionBusy = session.commandPending !== null
  const activeError = viewingHistory ? history.error : realtime.error

  const logView = useMemo(() => buildLogView(logs, {
    mode: contentMode,
    level: filter,
    search,
    collapseRepeats,
  }), [collapseRepeats, contentMode, filter, logs, search])

  const viewHistoryFile = (file: LogFile) => {
    setAutoScroll(false)
    session.enterHistory(file)
  }

  const backToRealtime = () => {
    setAutoScroll(true)
    session.backToRealtime()
  }

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
    const logText = formatLogExport(logView.filtered)
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
        canExport={logView.filtered.length > 0}
        onClear={() => setConfirmAction('clear')}
        onExport={exportLogs}
      />

      <LogConsole
        viewingHistory={viewingHistory}
        selectedFile={history.selectedFile}
        loading={loading}
        error={activeError}
        logs={logs}
        view={logView}
        autoScroll={autoScroll}
        paused={realtime.paused}
        onRetry={retryActiveLogs}
        onBackToRealtime={backToRealtime}
      />

      <HistoryLogPicker
        files={history.files}
        filesError={history.filesError}
        selectedFile={history.selectedFile}
        cleanupDisabled={actionBusy || history.files.length === 0 || viewingHistory}
        onSelect={viewHistoryFile}
        onCleanup={() => setConfirmAction('cleanup')}
        onReload={() => void history.reloadFiles()}
      />

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
    </>
  )
}
