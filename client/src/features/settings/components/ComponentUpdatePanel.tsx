/**
 * 组件更新面板
 *
 * 版本由 `settings/version` Query 持有，core/渠道/CLI/资源四条命令由
 * `SettingsUpdateOwner` 持有；面板只订阅这两者并渲染版本、按钮 loading
 * 与反馈。自动更新策略由独立面板持有，不随更新命令状态重渲染。
 */

import { Download, RefreshCw } from 'lucide-react'
import { Button } from '@/shared/ui'
import { useStatusStore } from '@/features/runtime-status'
import { useSettingsUpdates } from '../hooks/useSettingsUpdates'
import { useSettingsVersion } from '../hooks/useSettingsVersion'

export default function ComponentUpdatePanel() {
  const setStatusMessage = useStatusStore(state => state.setMessage)
  const {
    version: versionInfo,
    reload: reloadVersion,
  } = useSettingsVersion()
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

  return (
    <>
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
    </>
  )
}
