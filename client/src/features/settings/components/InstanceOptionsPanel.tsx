// 实例选项与连接配置分属同一 MAA profile 的不同 section：面板只在 instance
// section 渲染，但草稿与读取反馈由模块级 owner 持有，切换 section 不丢草稿。

import { useEffect, useRef, useState } from 'react'
import { Select, Switch } from '@/shared/ui'
import { useStatusStore } from '@/features/runtime-status'
import { useSettingsInstanceOptions } from '../hooks/useSettingsInstanceOptions'
import { CONFIG_SECTION_VIEWS } from './configSectionViews'
import ConfigEditorCard from './ConfigEditorCard'
import type { SettingsFeedback } from './ConfigEditorCard'
import { MAA_TOUCH_MODES } from '../types'
import type { MaaTouchMode } from '../types'

const TOUCH_MODE_LABELS: Record<MaaTouchMode, string> = {
  Adb: 'ADB',
  MiniTouch: 'MiniTouch',
  MaaTouch: 'MaaTouch（推荐）',
  MacPlayTools: 'MacPlayTools（PlayCover）',
  MaaFwAdb: 'MaaFwAdb',
}

const TOUCH_MODE_OPTIONS = MAA_TOUCH_MODES.map(mode => ({
  value: mode,
  label: TOUCH_MODE_LABELS[mode],
}))

export interface InstanceOptionsPanelProps {
  /** 只有 instance section 渲染可写表单；隐藏时保留订阅与反馈。 */
  readonly isActive: boolean
}

export default function InstanceOptionsPanel({ isActive }: InstanceOptionsPanelProps) {
  const setStatusMessage = useStatusStore(state => state.setMessage)
  const {
    draft,
    update,
    restoreDefaults,
    save,
    syncState,
    loadError,
    loaded,
  } = useSettingsInstanceOptions(undefined, 'default', isActive)
  const saving = syncState === 'saving'
  const blockedSaveMessage = loadError
    ? '实例选项读取失败，暂时无法保存'
    : '实例选项正在读取，加载完成后才能保存'
  const saveBlockedReason = loaded ? null : blockedSaveMessage
  const [configFeedback, setConfigFeedback] = useState<SettingsFeedback | null>(null)
  const reportedLoadFailureRef = useRef<string | null>(null)

  useEffect(() => {
    if (!loadError) return
    const message = `实例选项读取失败: ${loadError}（保存已禁用，请刷新页面后重试）`
    if (reportedLoadFailureRef.current === message) return
    reportedLoadFailureRef.current = message
    // 读取失败同步为页内反馈；ref 保证同一失败只提示一次，不是渲染循环。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConfigFeedback({ type: 'error', message })
    setStatusMessage(message, 'error')
  }, [loadError, setStatusMessage])

  useEffect(() => {
    if (!loaded || !reportedLoadFailureRef.current) return
    const message = reportedLoadFailureRef.current
    reportedLoadFailureRef.current = null
    setConfigFeedback(current => (current?.message === message ? null : current))
  }, [loaded])

  const updateInstanceOptions = (patch: Parameters<typeof update>[0]) => {
    update(patch)
    setConfigFeedback(null)
  }

  const handleSave = async () => {
    if (!loaded) {
      setConfigFeedback({ type: 'warning', message: blockedSaveMessage })
      setStatusMessage(blockedSaveMessage, 'warning')
      return
    }
    if (saving) return
    setConfigFeedback(null)
    setStatusMessage('正在保存实例选项...', 'info')

    const outcome = await save()
    if (outcome.status === 'ignored') return

    if (outcome.status === 'saved') {
      if (outcome.superseded) {
        const message = '此前实例选项已保存，当前更改尚未保存'
        setConfigFeedback({ type: 'warning', message })
        setStatusMessage(message, 'warning')
      } else {
        const message = '实例选项保存成功'
        setConfigFeedback({ type: 'success', message })
        setStatusMessage(message, 'success')
      }
      return
    }

    const message = `实例选项保存失败: ${outcome.message ?? '未知错误'}`
    setConfigFeedback({ type: 'error', message })
    setStatusMessage(message, 'error')
  }

  const handleReset = () => {
    restoreDefaults()
    setConfigFeedback(null)
    setStatusMessage('已重置实例选项为默认值')
  }

  if (!isActive) return null

  return (
    <ConfigEditorCard
      title={CONFIG_SECTION_VIEWS.instance.name}
      feedback={configFeedback}
      saving={saving}
      saveDisabled={!loaded}
      saveBlockedReason={saveBlockedReason}
      onSave={() => void handleSave()}
      onReset={handleReset}
    >
      <Select
        label="触控模式"
        value={draft.touch_mode}
        onChange={(value: string) => {
          updateInstanceOptions({ touch_mode: value as MaaTouchMode })
        }}
        options={TOUCH_MODE_OPTIONS}
        hint="ADB 兼容性最好；MaaTouch 触控更接近真实点击"
      />

      <div className="config-switch-list flex flex-col gap-3">
        <div className="config-reconnect-row flex min-h-14 items-center justify-between gap-3 py-1">
          <div className="min-w-0">
            <div className="text-sm font-medium text-primary">部署时暂停</div>
            <div className="mt-1 text-xs leading-5 text-tertiary">开启后部署干员时暂停游戏，适用于部分特殊关卡</div>
          </div>
          <Switch
            label="部署时暂停"
            checked={draft.deployment_with_pause}
            onChange={(checked: boolean) => {
              updateInstanceOptions({ deployment_with_pause: checked })
            }}
          />
        </div>
        <div className="config-reconnect-row flex min-h-14 items-center justify-between gap-3 py-1">
          <div className="min-w-0">
            <div className="text-sm font-medium text-primary">ADB Lite</div>
            <div className="mt-1 text-xs leading-5 text-tertiary">使用 AdbLite 减少 ADB 调用开销</div>
          </div>
          <Switch
            label="启用 ADB Lite"
            checked={draft.adb_lite_enabled}
            onChange={(checked: boolean) => {
              updateInstanceOptions({ adb_lite_enabled: checked })
            }}
          />
        </div>
        <div className="config-reconnect-row flex min-h-14 items-center justify-between gap-3 py-1">
          <div className="min-w-0">
            <div className="text-sm font-medium text-primary">退出时结束 ADB</div>
            <div className="mt-1 text-xs leading-5 text-tertiary">任务结束后由 MAA 关闭自己启动的 ADB 进程</div>
          </div>
          <Switch
            label="退出时结束 ADB"
            checked={draft.kill_adb_on_exit}
            onChange={(checked: boolean) => {
              updateInstanceOptions({ kill_adb_on_exit: checked })
            }}
          />
        </div>
      </div>

    </ConfigEditorCard>
  )
}
