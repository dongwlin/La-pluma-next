import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Save, Send } from 'lucide-react'
import type { ApiResponse } from '@/shared/api'
import { Switch } from '@/shared/ui'
import { saveNotificationConfig, testNotificationChannel } from '../api'
import {
  cloneNotificationConfig,
  type NotificationConfig,
  type TelegramConfig,
} from '../model/notificationConfig'
import { notificationConfigQueryOptions } from '../model/queries'

const getResponseMessage = (data: Partial<ApiResponse>, fallback: string) =>
  data.message || data.errorInfo?.message || data.error || fallback

const getErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

export default function NotificationSettings() {
  const queryClient = useQueryClient()
  const configQuery = useQuery(notificationConfigQueryOptions())
  const [config, setConfig] = useState<NotificationConfig>(() => cloneNotificationConfig())
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const mountedRef = useRef(false)
  const activationRevisionRef = useRef(0)
  const draftRevisionRef = useRef(0)
  const committedRevisionRef = useRef(0)
  const saveRequestIdRef = useRef(0)
  const testAbortRef = useRef<AbortController | null>(null)

  const loading = configQuery.isPending
  const loadError = configQuery.isError
    ? getErrorMessage(configQuery.error, '加载通知配置失败')
    : null

  useEffect(() => {
    const activationRevision = ++activationRevisionRef.current
    mountedRef.current = true
    setTesting(false)

    return () => {
      if (activationRevisionRef.current === activationRevision) activationRevisionRef.current += 1
      mountedRef.current = false
      // 仅中止可丢弃的“测试通知”；保存必须完成落盘并写回 Query 缓存。
      testAbortRef.current?.abort()
    }
  }, [])

  // 服务端快照到达或重读成功时采用它；有未保存编辑时保留本地草稿。
  useEffect(() => {
    if (!configQuery.data) return
    if (draftRevisionRef.current !== committedRevisionRef.current) return
    setConfig(cloneNotificationConfig(configQuery.data))
  }, [configQuery.data])

  const refetchConfig = configQuery.refetch
  const loadConfig = useCallback(async (force = false) => {
    if (force) setNotice(null)
    await refetchConfig()
  }, [refetchConfig])

  const updateConfig = (updater: (current: NotificationConfig) => NotificationConfig) => {
    draftRevisionRef.current += 1
    setNotice(null)
    setConfig(updater)
  }

  const updateTelegram = (patch: Partial<TelegramConfig>) => {
    updateConfig(current => ({
      ...current,
      channels: {
        ...current.channels,
        telegram: {
          ...current.channels.telegram,
          ...patch
        }
      }
    }))
  }

  const saveConfig = async () => {
    const configSnapshot = cloneNotificationConfig(config)
    const revisionSnapshot = draftRevisionRef.current
    const requestId = ++saveRequestIdRef.current
    setSaving(true)
    setNotice(null)

    try {
      // 不绑定 AbortSignal：页面隐藏或卸载不能取消保存，否则服务端可能已落盘
      // 而本地缓存仍是旧值。用请求序号裁决迟到响应。
      const data = await saveNotificationConfig(configSnapshot)
      if (saveRequestIdRef.current !== requestId) return

      if (data.success) {
        queryClient.setQueryData(notificationConfigQueryOptions().queryKey, configSnapshot)
        committedRevisionRef.current = revisionSnapshot
        if (mountedRef.current) setNotice({ type: 'success', text: data.message || '通知配置已保存' })
      } else if (mountedRef.current) {
        setNotice({ type: 'error', text: getResponseMessage(data, '通知配置保存失败') })
      }
    } catch (error) {
      if (saveRequestIdRef.current === requestId && mountedRef.current) {
        setNotice({ type: 'error', text: getErrorMessage(error, '通知配置保存失败') })
      }
    } finally {
      if (saveRequestIdRef.current === requestId && mountedRef.current) setSaving(false)
    }
  }

  const testNotification = async () => {
    const controller = new AbortController()
    const telegramSnapshot = { ...config.channels.telegram }
    testAbortRef.current?.abort()
    testAbortRef.current = controller
    setTesting(true)
    setNotice(null)

    try {
      const data = await testNotificationChannel('telegram', telegramSnapshot, controller.signal)
      if (controller.signal.aborted || !mountedRef.current || testAbortRef.current !== controller) return

      setNotice(data.success
        ? { type: 'success', text: data.message || '测试通知已发送' }
        : { type: 'error', text: getResponseMessage(data, '测试通知失败') })
    } catch (error) {
      if (controller.signal.aborted || !mountedRef.current || testAbortRef.current !== controller) return
      setNotice({ type: 'error', text: getErrorMessage(error, '测试通知失败') })
    } finally {
      if (testAbortRef.current === controller) {
        testAbortRef.current = null
        if (mountedRef.current) setTesting(false)
      }
    }
  }

  const telegram = config.channels.telegram
  const canTest = telegram.enabled && Boolean(telegram.botToken && telegram.chatId)

  return (
    <section className="automation-notification-panel">
      <div className="automation-notification-heading">
        <div>
          <h4><Bell size={16} strokeWidth={1.8} aria-hidden="true" /><span>通知</span></h4>
          <p>任务完成后发送结果</p>
        </div>
        <Switch
          checked={config.enabled}
          onChange={(enabled) => updateConfig(current => ({ ...current, enabled }))}
          disabled={loading || saving || Boolean(loadError)}
          label="任务通知"
          className="automation-section-switch"
        />
      </div>

      {loadError && (
        <div className="automation-notification-notice is-error flex min-h-11 flex-wrap items-center justify-between gap-2" role="alert">
          <span>{loadError}</span>
          <button type="button" className="min-h-11 rounded-lg px-3 font-semibold focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-(--app-accent)" onClick={() => void loadConfig(true)} disabled={loading || configQuery.isFetching}>
            重新加载
          </button>
        </div>
      )}

      {notice && !loadError && (
        <div className={`automation-notification-notice is-${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.text}</div>
      )}

      <div className="automation-notification-channel">
        <div className="automation-notification-channel-heading">
          <div>
            <strong>Telegram</strong>
            <small>机器人通知</small>
          </div>
          <Switch
            checked={telegram.enabled}
            onChange={(enabled) => updateTelegram({ enabled })}
            disabled={loading || saving || Boolean(loadError)}
            label="Telegram 通知"
            className="automation-section-switch"
          />
        </div>

        {telegram.enabled && (
          <div className="automation-notification-details">
            <label className="automation-notification-field">
              <span>Bot Token</span>
              <input
                type="text"
                value={telegram.botToken}
                onChange={(event) => updateTelegram({ botToken: event.target.value })}
                placeholder="Telegram Bot Token"
                disabled={loading || saving || Boolean(loadError)}
                autoComplete="off"
                className="app-native-control"
              />
            </label>

            <label className="automation-notification-field">
              <span>Chat ID</span>
              <input
                type="text"
                value={telegram.chatId}
                onChange={(event) => updateTelegram({ chatId: event.target.value })}
                placeholder="Telegram Chat ID"
                disabled={loading || saving || Boolean(loadError)}
                autoComplete="off"
                className="app-native-control"
              />
            </label>
          </div>
        )}

        <div className="automation-notification-buttons">
          <button type="button" onClick={testNotification} disabled={loading || saving || testing || Boolean(loadError) || !canTest} className="app-native-button">
            <Send size={14} />
            <span>{loading ? '加载中' : testing ? '发送中' : '测试'}</span>
          </button>
          <button type="button" onClick={saveConfig} disabled={loading || saving || testing || Boolean(loadError)} className="app-native-button app-native-button-primary is-primary">
            <Save size={14} />
            <span>{loading ? '加载中' : saving ? '保存中' : '保存'}</span>
          </button>
        </div>
      </div>
    </section>
  )
}
