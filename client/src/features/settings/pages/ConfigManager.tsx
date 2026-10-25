import { useState, useEffect, useRef } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  Cable,
  Clock3,
  Download,
  FolderOpen,
  LockKeyhole,
  MonitorSmartphone,
  PackageOpen,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
} from 'lucide-react'
import { PageHeader, Card, CardHeader, CardContent, Button, Input, Select, Checkbox, Switch } from '@/shared/ui'
import { FloatingStatusIndicator, useStatusStore } from '@/features/runtime-status'
import { useFluidTabIndicator } from '@/shared/hooks/useFluidTabIndicator'
import type {
  MaaConnectionConfig,
  ConfigSection,
} from '../types'
import { useConfigSection } from '../hooks/useConfigSection'
import { useSettingsConnectionConfig } from '../hooks/useSettingsConnectionConfig'
import { useSettingsDeviceConnection } from '../hooks/useSettingsDeviceConnection'
import { useSettingsConfigDirectory } from '../hooks/useSettingsConfigDirectory'
import { useSettingsVersion } from '../hooks/useSettingsVersion'
import { useSettingsAutoUpdate } from '../hooks/useSettingsAutoUpdate'
import { useSettingsUpdates } from '../hooks/useSettingsUpdates'
import {
  CONFIG_SECTION_IDS,
  isEditableConfigSection,
} from '../model/configSection'
import type { DiscoveredDevice } from '../model/deviceConnection'

interface SettingsFeedback {
  type: 'success' | 'error' | 'warning'
  message: string
}

export default function ConfigManager() {
  const { setMessage: setStatusMessage } = useStatusStore()
  const shouldReduceMotion = useReducedMotion()
  const { section: configType, selectSection: handleConfigTypeChange } = useConfigSection()
  const {
    containerRef: configTabsRef,
    activeRect: activeConfigRect,
    setTabRef: setConfigTabRef,
    handleTabKeyDown: handleConfigTabKeyDown,
  } = useFluidTabIndicator(configType)
  const {
    draft: configData,
    update: updateConnectionDraft,
    restoreDefaults,
    save: saveConnectionConfig,
    syncState: connectionSyncState,
    loadError: connectionLoadError,
    loaded: connectionLoaded,
  } = useSettingsConnectionConfig()
  const connectionSaving = connectionSyncState === 'saving'
  const { version: versionInfo } = useSettingsVersion()
  const {
    path: configDir,
    status: configDirStatus,
    error: configDirError,
    reload: reloadConfigDir,
    open: openConfigDirectory,
  } = useSettingsConfigDirectory()
  const {
    discovery: deviceDiscovery,
    test: connectionTest,
    discover: discoverDevices,
    testConnection,
    selectDevice: selectDiscoveredDevice,
    clearTestFeedback,
  } = useSettingsDeviceConnection()
  const discoveredDevices = deviceDiscovery.devices
  const discoveryMessage = deviceDiscovery.message
  const hasSearchedDevices = deviceDiscovery.searched
  const discoveringDevices = deviceDiscovery.phase === 'running'
  const testingConnection = connectionTest.phase === 'running'
  const connectionFeedback = connectionTest.message
    ? { success: connectionTest.success, message: connectionTest.message }
    : null
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
  } = useSettingsUpdates(setStatusMessage)
  const updatingCore = updateOperation === 'core' || updateOperation === 'core-channel'
  const updatingCli = updateOperation === 'cli'
  const hotUpdating = updateOperation === 'resources'
  const [configFeedback, setConfigFeedback] = useState<SettingsFeedback | null>(null)
  const reportedLoadFailureRef = useRef<string | null>(null)

  // 初始读取失败保留旧的页内与全局提示；后台刷新失败不打断已有草稿。
  useEffect(() => {
    if (!connectionLoadError) return
    const message = `连接配置读取失败: ${connectionLoadError}`
    if (reportedLoadFailureRef.current === message) return
    reportedLoadFailureRef.current = message
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

  const handleDiscoverDevices = () => {
    discoverDevices(configData.adb_path)
  }

  const handleTestConnection = (address = configData.address) => {
    testConnection(configData.adb_path, address)
  }

  const handleUseDiscoveredDevice = (device: DiscoveredDevice) => {
    setConfigFeedback(null)
    selectDiscoveredDevice(device)
  }

  const handleOpenConfigDir = async () => {
    const result = await openConfigDirectory()
    setStatusMessage(result.success ? '已打开配置目录' : `打开失败: ${result.message}`)
  }

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

  const configSections = [
    {
      id: 'connection',
      name: '连接',
      description: 'ADB 与模拟器',
      icon: <MonitorSmartphone aria-hidden="true" />,
    },
    {
      id: 'resource',
      name: '资源',
      description: '资源来源与目录',
      icon: <PackageOpen aria-hidden="true" />,
    },
    {
      id: 'instance',
      name: '实例',
      description: '运行与触控选项',
      icon: <SlidersHorizontal aria-hidden="true" />,
    },
  ] satisfies Array<ConfigSection & { description: string }>

  return (
    <div className="app-page app-stack-section ios-workspace-page ios-borderless-cards" data-page="config">
      <PageHeader
        title="配置"
        subtitle="连接设备、管理运行选项与组件更新"
        mobileLayout="inline"
        actions={(
          <FloatingStatusIndicator
            className="w-full overflow-hidden sm:w-auto"
            textClassName="truncate whitespace-nowrap"
          />
        )}
      />

      <div className="app-workspace-segments app-liquid-tab-pill w-full" data-config-sections>
        <div
          ref={configTabsRef}
          className="app-workspace-segment-list grid-cols-3"
          role="toolbar"
          aria-label="配置类型"
        >
          {activeConfigRect.width > 0 && (
            <motion.div
              data-testid="config-section-highlight"
              aria-hidden="true"
              className="app-workspace-segment-indicator"
              initial={false}
              animate={{
                x: activeConfigRect.x,
                y: activeConfigRect.y,
                width: activeConfigRect.width,
                height: activeConfigRect.height,
              }}
              transition={shouldReduceMotion
                ? { duration: 0 }
                : { type: 'spring', stiffness: 420, damping: 38, mass: 0.72 }}
            />
          )}
          {configSections.map(section => {
            const selected = configType === section.id
            return (
              <button
                key={section.id}
                ref={element => setConfigTabRef(section.id)(element)}
                type="button"
                onClick={() => handleConfigTypeChange(section.id)}
                onKeyDown={event => handleConfigTabKeyDown(
                  event,
                  CONFIG_SECTION_IDS,
                  handleConfigTypeChange,
                )}
                aria-pressed={selected}
                tabIndex={selected ? 0 : -1}
                className={`app-workspace-segment min-h-11 ${selected ? 'is-selected' : ''}`}
              >
                <span className="app-workspace-segment-icon">{section.icon}</span>
                <span className="app-workspace-segment-copy">
                  <span>{section.name}</span>
                  <small>{section.description}</small>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="config-workspace-grid grid min-w-0 gap-(--app-space-section) xl:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)] xl:items-start">
        <div className="config-workspace-primary app-stack-section min-w-0">
      <Card smoothCorners className="config-editor-card p-0!">
        <CardHeader
          title={configSections.find(section => section.id === configType)?.name || '配置'}
          actions={isEditableConfigSection(configType) ? (
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
          ) : (
            <Button
              type="button"
              onClick={handleOpenConfigDir}
              variant="outline"
              size="sm"
              disabled={configDirStatus !== 'ready' || !configDir}
              icon={<FolderOpen size={16} aria-hidden="true" />}
            >
              打开目录
            </Button>
          )}
        />
        <CardContent>
          {isEditableConfigSection(configType) && (
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

              <section className="surface-soft rounded-xl p-(--app-space-panel)" aria-label="模拟器查找与连接测试">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="icon-well flex h-9 w-9 shrink-0 items-center justify-center rounded-lg brand-text">
                      <Cable size={18} aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-primary">模拟器连接</h3>
                      <p className="mt-1 text-xs leading-5 text-tertiary">查找本机模拟器，或测试当前连接地址。</p>
                    </div>
                  </div>
                  <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      loading={discoveringDevices}
                      loadingText="查找中"
                      onClick={() => void handleDiscoverDevices()}
                      className="flex-1 sm:flex-none"
                      icon={<Search size={16} aria-hidden="true" />}
                    >
                      查找模拟器
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      loading={testingConnection}
                      loadingText="测试中"
                      onClick={() => void handleTestConnection()}
                      className="flex-1 sm:flex-none"
                      icon={<Cable size={16} aria-hidden="true" />}
                    >
                      测试连接
                    </Button>
                  </div>
                </div>

                {discoveryMessage && (
                  <p className="mt-3 text-xs text-secondary" role="status">{discoveryMessage}</p>
                )}

                {discoveredDevices.length > 0 && (
                  <div className="config-device-list mt-3 divide-y divide-(--app-border) overflow-hidden rounded-lg bg-(--app-surface) shadow-[inset_0_0_0_1px_var(--app-border)]">
                    {discoveredDevices.map(device => {
                      const selectable = device.state === 'device' || device.state === 'candidate'
                      const stateLabel = device.state === 'device'
                        ? '已连接'
                        : device.state === 'candidate'
                          ? '可尝试连接'
                          : device.state === 'offline'
                            ? '设备离线'
                            : device.state === 'unauthorized'
                              ? '等待授权'
                              : '状态未知'
                      return (
                        <button
                          key={`${device.source}-${device.address}`}
                          type="button"
                          disabled={!selectable || testingConnection}
                          onClick={() => void handleUseDiscoveredDevice(device)}
                          className="flex min-h-12 w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-(--app-accent-soft) focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--app-accent) disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-primary">{device.address}</span>
                            <span className="mt-0.5 block truncate text-xs text-tertiary">{device.details || (device.source === 'adb' ? 'ADB 已识别设备' : device.source === 'emulator-adb' ? '模拟器内置 ADB' : '本机端口')}</span>
                          </span>
                          <span className="shrink-0 rounded-full bg-(--app-surface-muted) px-2 py-1 text-xs text-secondary">{stateLabel}</span>
                        </button>
                      )
                    })}
                  </div>
                )}

                {hasSearchedDevices && !discoveredDevices.length && (
                  <p className="mt-3 text-xs leading-5 text-tertiary">未找到已连接设备。启动模拟器后重新查找，或手动填写连接地址。</p>
                )}

                {connectionFeedback && (
                  <div className={`mt-3 rounded-lg px-3 py-2.5 text-xs ${connectionFeedback.success ? 'status-success' : 'status-danger'}`} role={connectionFeedback.success ? 'status' : 'alert'}>
                    {connectionFeedback.message}
                  </div>
                )}
              </section>

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
          )}

          {configType === 'resource' && (
            <section className="surface-soft flex items-start gap-3 rounded-xl p-(--app-space-panel)" aria-labelledby="resource-config-readonly-title">
              <span className="icon-well flex h-9 w-9 shrink-0 items-center justify-center rounded-lg brand-text">
                <LockKeyhole size={18} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h3 id="resource-config-readonly-title" className="text-sm font-semibold text-primary">资源配置由 MAA 管理</h3>
                <p className="mt-1 text-sm leading-6 text-secondary">当前资源来源保持不变。需要调整时，可打开配置目录编辑对应文件。</p>
              </div>
            </section>
          )}

          {configType === 'instance' && (
            <section className="surface-soft flex items-start gap-3 rounded-xl p-(--app-space-panel)" aria-labelledby="instance-config-readonly-title">
              <span className="icon-well flex h-9 w-9 shrink-0 items-center justify-center rounded-lg brand-text">
                <LockKeyhole size={18} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h3 id="instance-config-readonly-title" className="text-sm font-semibold text-primary">实例选项由 MAA 管理</h3>
                <p className="mt-1 text-sm leading-6 text-secondary">触摸模式等实例选项保持当前设置。需要调整时，可打开配置目录编辑对应文件。</p>
              </div>
            </section>
          )}
        </CardContent>
      </Card>

      <Card smoothCorners className="config-directory-card p-0!">
        <CardContent>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <span className="icon-well flex h-10 w-10 shrink-0 items-center justify-center rounded-lg brand-text">
                <FolderOpen size={20} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-primary">配置目录</h2>
                {configDirStatus === 'error' ? (
                  <p className="mt-1 wrap-break-word text-sm text-danger wrap-anywhere" role="alert">{configDirError}</p>
                ) : (
                  <p className="mt-1 wrap-break-word font-mono text-xs leading-5 text-secondary wrap-anywhere" aria-live="polite">
                    {configDirStatus === 'loading' ? '正在读取目录...' : configDir}
                  </p>
                )}
              </div>
            </div>
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              {configDirStatus === 'error' && (
                <Button
                  onClick={() => void reloadConfigDir()}
                  variant="outline"
                  size="sm"
                  className="flex-1 sm:flex-none"
                  icon={<RefreshCw size={16} aria-hidden="true" />}
                >
                  重试
                </Button>
              )}
              <Button
                onClick={handleOpenConfigDir}
                variant="outline"
                size="sm"
                className="flex-1 sm:flex-none"
                disabled={configDirStatus !== 'ready' || !configDir}
                icon={<FolderOpen size={16} aria-hidden="true" />}
              >
                打开目录
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
        </div>

        <div className="config-workspace-secondary app-stack-section min-w-0">
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
        </div>
      </div>
    </div>
  )
}
