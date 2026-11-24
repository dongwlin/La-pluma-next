import { useCallback, useEffect, useRef, useState } from 'react'
import { dismissNotice, notify, notifyProgress } from '@/shared/notifications'
import type { ConfigEditorFeedback } from '../components/ConfigEditorCard'
import type { ConfigSaveOutcome } from '../model/configDraftOwner'

export interface ConfigDraftPanelOptions<T extends Record<string, unknown>> {
  /** 页面可见名称，用于读取失败、保存成功与保存失败提示。 */
  readonly label: string
  readonly noticeId: string
  readonly savingMessage: string
  readonly loadError: string | null
  readonly loaded: boolean
  readonly saving: boolean
  readonly save: () => Promise<ConfigSaveOutcome<T>>
}

/**
 * 设置页各 section 共用的草稿面板反馈：读取失败保留页内警示与全局提示，
 * 保存成功/未保存警告只走全局状态，保存失败同时保留页内错误。
 */
export function useConfigDraftPanel<T extends Record<string, unknown>>({
  label,
  noticeId,
  savingMessage,
  loadError,
  loaded,
  saving,
  save,
}: ConfigDraftPanelOptions<T>) {
  const [feedback, setFeedback] = useState<ConfigEditorFeedback | null>(null)
  const reportedLoadFailureRef = useRef<string | null>(null)

  useEffect(() => {
    if (!loadError) return
    const message = `${label}读取失败: ${loadError}`
    if (reportedLoadFailureRef.current === message) return
    reportedLoadFailureRef.current = message
    // 读取失败同步为页内反馈；ref 保证同一失败只提示一次，不是渲染循环。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFeedback({ type: 'error', message })
    notify(message, 'error')
  }, [label, loadError])

  useEffect(() => {
    if (!loaded || !reportedLoadFailureRef.current) return
    const message = reportedLoadFailureRef.current
    reportedLoadFailureRef.current = null
    setFeedback(current => (current?.message === message ? null : current))
  }, [loaded])

  const saveWithFeedback = useCallback(async () => {
    if (!loaded) return
    if (saving) return
    setFeedback(null)
    notifyProgress(savingMessage, noticeId)

    let outcome: ConfigSaveOutcome<T>
    try {
      outcome = await save()
    } catch (error) {
      const message = `${label}保存失败: ${error instanceof Error ? error.message : '未知错误'}`
      setFeedback({ type: 'error', message })
      notify(message, 'error', { id: noticeId })
      return
    }
    if (outcome.status === 'ignored') {
      dismissNotice(noticeId)
      return
    }

    if (outcome.status === 'saved') {
      if (outcome.superseded) {
        notify(`此前${label}已保存，当前更改尚未保存`, 'warning', { id: noticeId })
      } else {
        notify(`${label}保存成功`, 'success', { id: noticeId })
      }
      return
    }

    const message = `${label}保存失败: ${outcome.message ?? '未知错误'}`
    setFeedback({ type: 'error', message })
    notify(message, 'error', { id: noticeId })
  }, [label, loaded, noticeId, save, saving, savingMessage])

  return { feedback, setFeedback, save: saveWithFeedback }
}
