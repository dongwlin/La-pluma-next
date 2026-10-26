/**
 * 连接配置面板
 *
 * 服务端读取与草稿保存由 `useSettingsConnectionConfig` 背后的 Query/owner
 * 持有；面板只渲染表单、按钮 loading 与页内/全局反馈，不维护第二份草稿
 * 或 revision。
 *
 * 非 connection section 时返回 null，但组件保持挂载：section 切换不重建
 * Query 观察者，也不清空草稿与保存/读取反馈。设备状态由设备面板单独订阅，
 * 更新与自动更新由更新面板单独订阅，互不驱动对方的渲染。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { RotateCcw, Save } from 'lucide-react'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  Input,
  Select,
  Switch,
} from '@/shared/ui'
import { useStatusStore } from '@/features/runtime-status'
import { useSettingsConnectionConfig } from '../hooks/useSettingsConnectionConfig'
import { useClearConnectionTestFeedback } from '../hooks/useSettingsDeviceConnection'
import { CONFIG_SECTION_VIEWS } from './configSectionViews'
import DeviceConnectionPanel from './DeviceConnectionPanel'
import type { MaaConnectionConfig } from '../types'

interface SettingsFeedback {
  type: 'success' | 'error' | 'warning'
  message: string
}

export interface ConnectionConfigPanelProps {
  /** 只有 connection section 渲染可写表单；隐藏时仍保留订阅与本地反馈。 */
  readonly isActive: boolean
}

export default function ConnectionConfigPanel({ isActive }: ConnectionConfigPanelProps) {
  const { setMessage: setStatusMessage } = useStatusStore()
  const {
    draft: configData,
    update: updateConnectionDraft,
    restoreDefaults,
    save: saveConnectionConfig,
    syncState: connectionSyncState,
    loadError: connectionLoadError,
    loaded: connectionLoaded,
  } = useSettingsConnectionConfig()
  const clearTestFeedback = useClearConnectionTestFeedback()
  const connectionSaving = connectionSyncState === 'saving'
  const [configFeedback, setConfigFeedback] = useState<SettingsFeedback | null>(null)
  const reportedLoadFailureRef = useRef<string | null>(null)

  // 初始读取失败保留旧的页内与全局提示；后台刷新失败不打断已有草稿。
  useEffect(() => {
    if (!connectionLoadError) return
    const message = `连接配置读取失败: ${connectionLoadError}`
    if (reportedLoadFailureRef.current === message) return
    reportedLoadFailureRef.current = message
    // 读取失败同步为页内反馈；ref 保证同一失败只提示一次，不是渲染循环。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConfigFeedback({ type: 'error', message })
    setStatusMessage(message, 'error')
  }, [connectionLoadError, setStatusMessage])

  useEffect(() => {
    if (!connectionLoaded || !reportedLoadFailureRef.current) return
    const message = reportedLoadFailureRef.current
    reportedLoadFailureRef.current = null
    setConfigFeedback(current => (current?.message === message ? null : current))
  }, [connectionLoaded])

  const updateConnectionConfig = (patch: Partial<MaaConnectionConfig>) => {
    updateConnectionDraft(patch)
    setConfigFeedback(null)
  }

  const handleSave = async () => {
    if (connectionSaving) return
    setConfigFeedback(null)
    setStatusMessage('正在保存配置...', 'info')

    const outcome = await saveConnectionConfig()
    if (outcome.status === 'ignored') return

    if (outcome.status === 'saved') {
      if (outcome.superseded) {
        const message = '此前连接配置已保存，当前更改尚未保存'
        setConfigFeedback({ type: 'warning', message })
        setStatusMessage(message, 'warning')
      } else {
        const message = '连接配置保存成功'
        setConfigFeedback({ type: 'success', message })
        setStatusMessage(message, 'success')
      }
      return
    }

    const message = `连接配置保存失败: ${outcome.message ?? '未知错误'}`
    setConfigFeedback({ type: 'error', message })
    setStatusMessage(message, 'error')
  }

  const handleReset = () => {
    restoreDefaults()
    setConfigFeedback(null)
    setStatusMessage('已重置为默认值')
  }

  // 地址输入变更清除旧测试反馈；不取消在途测试，与迁移前一致。
  const clearConfigFeedback = useCallback(() => setConfigFeedback(null), [])

  if (!isActive) return null

  return (
    <Card smoothCorners className="config-editor-card p-0!">
      <CardHeader
        title={CONFIG_SECTION_VIEWS.connection.name}
        actions={(
          <div className="flex items-center gap-2">
            <Button
              onClick={handleReset}
              disabled={connectionSaving}
              variant="outline"
              size="sm"
              icon={<RotateCcw size={16} aria-hidden="true" />}
            >
              重置
            </Button>
            <Button
              onClick={() => void handleSave()}
              loading={connectionSaving}
              loadingText="保存中"
              variant="primary"
              size="sm"
              icon={<Save size={16} aria-hidden="true" />}
            >
              保存
            </Button>
          </div>
        )}
      />
      <CardContent>
        <div className="app-stack-card">
          {configFeedback && (
            <div
              className={`rounded-lg px-3 py-2.5 text-xs leading-5 ${
                configFeedback.type === 'success'
                  ? 'status-success'
                  : configFeedback.type === 'warning'
                    ? 'status-warning'
                    : 'status-danger'
              }`}
              role={configFeedback.type === 'error' ? 'alert' : 'status'}
            >
              {configFeedback.message}
            </div>
          )}

          <div className="grid min-w-0 gap-(--app-space-card) md:grid-cols-2">
            <Input
              label="ADB 路径"
              value={configData.adb_path}
              onChange={(value: string) => {
                updateConnectionConfig({ adb_path: value })
              }}
              hint="ADB 可执行文件的完整路径"
            />
            <Input
              label="连接地址"
              value={configData.address}
              onChange={(value: string) => {
                updateConnectionConfig({ address: value })
                clearTestFeedback()
              }}
              hint="模拟器地址，例如 127.0.0.1:16384"
            />
          </div>

          <DeviceConnectionPanel
            adbPath={configData.adb_path}
            address={configData.address}
            onSelectDeviceStart={clearConfigFeedback}
          />

          <div className="grid min-w-0 gap-(--app-space-card) md:grid-cols-2 md:items-end">
            <Select
              label="平台配置"
              value={configData.config}
              onChange={(value: string) => {
                updateConnectionConfig({ config: value })
              }}
              options={[
                { value: 'CompatMac', label: 'CompatMac (macOS)' },
                { value: 'CompatPOSIXShell', label: 'CompatPOSIXShell (Linux)' },
                { value: 'General', label: 'General (Windows)' },
              ]}
              hint="选择与服务器系统匹配的平台预设"
            />
            <div className="config-reconnect-row flex min-h-14 items-center justify-between gap-3 py-1">
              <div className="min-w-0">
                <div className="text-sm font-medium text-primary">自动重连</div>
                <div className="mt-1 text-xs leading-5 text-tertiary">连接中断后自动尝试恢复</div>
              </div>
              <Switch
                label="启用自动重连"
                checked={configData.auto_reconnect !== false}
                onChange={(checked: boolean) => {
                  updateConnectionConfig({ auto_reconnect: checked })
                }}
              />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
