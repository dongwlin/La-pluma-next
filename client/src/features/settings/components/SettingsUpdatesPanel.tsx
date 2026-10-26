/**
 * 组件更新与自动更新面板
 *
 * 版本由 `settings/version` Query 持有；四条更新命令由模块级
 * `SettingsUpdateOwner` 持有；自动更新草稿、本地回退与完整提交由
 * `AutoUpdateConfigOwner` 持有。面板只订阅这些所有者并渲染反馈/loading，
 * 不维护第二份版本、更新或自动更新状态。
 *
 * 版本、更新与自动更新的状态变化只重渲染本面板；连接表单与设备面板不
 * 订阅这些所有者。
 */

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Clock3, Download, RefreshCw, Save } from 'lucide-react'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  Checkbox,
  Input,
  Switch,
} from '@/shared/ui'
import { useStatusStore } from '@/features/runtime-status'
import { useSettingsAutoUpdate } from '../hooks/useSettingsAutoUpdate'
import { useSettingsUpdates } from '../hooks/useSettingsUpdates'
import { useSettingsVersion } from '../hooks/useSettingsVersion'

export default function SettingsUpdatesPanel() {
  const { setMessage: setStatusMessage } = useStatusStore()
  const shouldReduceMotion = useReducedMotion()
  const {
    version: versionInfo,
    reload: reloadVersion,
  } = useSettingsVersion()
  const {
    draft: autoUpdate,
    dirty: autoUpdateDirty,
    saving: autoUpdateSaving,
    feedback: autoUpdateFeedback,
    update: updateAutoUpdate,
    save: saveAutoUpdateConfig,
  } = useSettingsAutoUpdate(setStatusMessage)
  const {
    running: updateOperation,
    feedback: updateFeedback,
    busy: updateBusy,
    updateCore,
    switchCoreChannel,
    updateCli,
    updateResources,
  } = useSettingsUpdates(setStatusMessage, reloadVersion)
  const updatingCore = updateOperation === 'core' || updateOperation === 'core-channel'
  const updatingCli = updateOperation === 'cli'
  const hotUpdating = updateOperation === 'resources'

  const handleUpdateCore = () => {
    void updateCore()
  }

  const handleUpdateCli = () => {
    void updateCli()
  }

  const handleToggleCoreVersion = () => {
    void switchCoreChannel(versionInfo?.core)
  }

  const handleHotUpdate = () => {
    void updateResources()
  }

  const handleSaveAutoUpdate = () => {
    void saveAutoUpdateConfig()
  }

  return (
    <Card smoothCorners className="config-update-card p-0!">
      <CardHeader title="组件更新" />
      <CardContent className="app-stack-card">
        <section className="surface-soft rounded-xl p-(--app-space-panel)">
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <span className="icon-well flex h-9 w-9 shrink-0 items-center justify-center rounded-lg brand-text">
                <Clock3 size={18} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-primary">自动更新</h3>
                <p className="mt-1 text-xs leading-5 text-tertiary">每天按设定时间更新所选组件</p>
              </div>
            </div>
            <Switch
              checked={autoUpdate.enabled}
              onChange={checked => updateAutoUpdate({ enabled: checked })}
              label="启用自动更新"
            />
          </div>

          <AnimatePresence initial={false}>
            {autoUpdate.enabled && (
              <motion.div
                initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                transition={{ duration: shouldReduceMotion ? 0.12 : 0.2 }}
                className="mt-4 grid gap-4 border-t border-(--app-border) pt-4 md:grid-cols-[12rem_minmax(0,1fr)] md:items-end xl:grid-cols-1 xl:items-stretch"
              >
                <Input
                  type="text"
                  label="更新时间"
                  value={autoUpdate.time}
                  onChange={(value: string) => updateAutoUpdate({ time: value })}
                  placeholder="HH:MM"
                  className="max-w-48"
                />
                <div className="flex min-h-11 flex-wrap items-center gap-x-5 gap-y-2">
                  <Checkbox
                    checked={autoUpdate.updateCore}
                    onChange={(checked: boolean) => updateAutoUpdate({ updateCore: checked })}
                    label="更新 MaaCore"
                  />
                  <Checkbox
                    checked={autoUpdate.updateCli}
                    onChange={(checked: boolean) => updateAutoUpdate({ updateCli: checked })}
                    label="更新 MAA CLI"
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {autoUpdateFeedback && (
            <div
              className={`mt-4 rounded-lg px-3 py-2.5 text-xs leading-5 ${
                autoUpdateFeedback.type === 'success'
                  ? 'status-success'
                  : autoUpdateFeedback.type === 'warning'
                    ? 'status-warning'
                    : 'status-danger'
              }`}
              role={autoUpdateFeedback.type === 'error' ? 'alert' : 'status'}
            >
              {autoUpdateFeedback.message}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-(--app-border) pt-4">
            <p className="text-xs text-tertiary">{autoUpdateDirty ? '有尚未保存的更改' : '设置会在保存后生效'}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={autoUpdateSaving}
              loadingText="保存中"
              disabled={!autoUpdateDirty || autoUpdateSaving}
              onClick={handleSaveAutoUpdate}
              icon={<Save size={16} aria-hidden="true" />}
            >
              保存自动更新
            </Button>
          </div>
        </section>

        <div className="grid gap-(--app-space-card) md:grid-cols-2 xl:grid-cols-1">
          <section className="surface-soft flex min-w-0 flex-col rounded-xl p-(--app-space-panel)">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-primary">MaaCore</h3>
              {versionInfo && <span className="text-sm brand-text">{versionInfo.core}</span>}
              {versionInfo && (
                <span className={`rounded-full px-2 py-1 text-xs ${versionInfo.core.includes('beta') || versionInfo.core.includes('alpha') ? 'status-warning' : 'status-success'}`}>
                  {versionInfo.core.includes('beta') || versionInfo.core.includes('alpha') ? '测试版' : '正式版'}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs leading-5 text-secondary">核心组件与游戏资源</p>
            {versionInfo?.resource && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-tertiary">
                  资源更新：{versionInfo.resource.lastUpdated
                    ? new Date(versionInfo.resource.lastUpdated.replace(' ', 'T')).toLocaleString('zh-CN', { hour12: false })
                    : '未知'}
                </span>
                <span className={`rounded-full px-2 py-1 font-medium ${versionInfo.resource.status === 'current' ? 'status-success' : 'status-warning'}`}>
                  {versionInfo.resource.status === 'current' ? '资源正常' : '需要同步'}
                </span>
              </div>
            )}
            {versionInfo?.resource && versionInfo.resource.status !== 'current' && (
              <p className="mt-2 text-xs leading-5 text-(--app-warning)">{versionInfo.resource.message}</p>
            )}
            <div className="mt-auto grid gap-2 pt-4 sm:grid-cols-2">
              <Button
                onClick={handleUpdateCore}
                disabled={updateBusy}
                loading={updatingCore}
                loadingText="更新中"
                variant="primary"
                className="w-full"
                icon={<Download size={16} aria-hidden="true" />}
              >
                更新 MaaCore
              </Button>
              <Button
                type="button"
                onClick={handleToggleCoreVersion}
                disabled={updateBusy}
                variant="secondary"
                className="w-full"
                icon={<RefreshCw size={16} aria-hidden="true" />}
              >
                {versionInfo?.core.includes('beta') || versionInfo?.core.includes('alpha') ? '切换正式版' : '切换测试版'}
              </Button>
              <Button
                onClick={handleHotUpdate}
                disabled={updateBusy}
                loading={hotUpdating}
                loadingText="同步中"
                variant="outline"
                className="w-full sm:col-span-2"
                icon={<RefreshCw size={16} aria-hidden="true" />}
              >
                仅同步游戏资源
              </Button>
            </div>
          </section>

          <section className="surface-soft flex min-w-0 flex-col rounded-xl p-(--app-space-panel)">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-primary">MAA CLI</h3>
              {versionInfo && <span className="text-sm brand-text">{versionInfo.cli}</span>}
              <span className="status-success rounded-full px-2 py-1 text-xs">正式版</span>
            </div>
            <p className="mt-1 text-xs leading-5 text-secondary">命令行工具与任务运行入口</p>
            <div className="mt-auto pt-4">
              <Button
                onClick={handleUpdateCli}
                disabled={updateBusy}
                loading={updatingCli}
                loadingText="更新中"
                variant="primary"
                fullWidth
                icon={<Download size={16} aria-hidden="true" />}
              >
                更新 MAA CLI
              </Button>
            </div>
          </section>
        </div>

        {updateFeedback && (
          <div className={`rounded-lg px-3 py-2.5 text-xs leading-5 ${updateFeedback.type === 'success' ? 'status-success' : 'status-warning'}`} role={updateFeedback.type === 'error' ? 'alert' : 'status'}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p>{updateFeedback.message}</p>
              {updateFeedback.resourceRetry && (
                <Button
                  type="button"
                  onClick={handleHotUpdate}
                  disabled={updateBusy}
                  variant="ghost"
                  size="sm"
                  className="min-h-11! lg:min-h-0!"
                  icon={<RefreshCw size={16} aria-hidden="true" />}
                >
                  重试资源同步
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
