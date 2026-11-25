import { useId, useState } from 'react'
import { Gauge, LoaderCircle, Package, Plug, RotateCw, Server, SlidersHorizontal, Smartphone, Unplug } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { DialogClose } from '@/shared/ui/dialog'
import { Separator } from '@/shared/ui/separator'
import { DialogBody, DialogFrame, DialogFrameFooter } from '@/shared/components'
import { fpsOptions, qualityPresets, SNAPSHOT_INTERVAL_SECONDS, type QualityPreset } from '../constants'
import { usePreviewStore } from '../store/previewStore'
import type { PreviewStatus } from '../model/previewStatus'
import type { usePreviewSession } from '../hooks/usePreviewSession'
import type { usePreviewInfrastructureView } from '../hooks/usePreviewInfrastructureView'

interface PreviewSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  session: ReturnType<typeof usePreviewSession>
  status: PreviewStatus
  infrastructure: ReturnType<typeof usePreviewInfrastructureView>
}

function formatStatistic(value: number | null | undefined, unit: string) {
  if (value === undefined || value === null || !Number.isFinite(value)) return '--'
  return `${value} ${unit}`
}

export function PreviewSettingsDialog({
  open,
  onOpenChange,
  session,
  status,
  infrastructure,
}: PreviewSettingsDialogProps) {
  const baseId = useId().replace(/:/g, '')
  const connectionHeadingId = `${baseId}-connection`
  const qualityHeadingId = `${baseId}-quality`
  const detailsHeadingId = `${baseId}-details`
  const bitrateId = `${baseId}-bitrate`
  const quality = usePreviewStore(state => state.quality)
  const customFps = usePreviewStore(state => state.fps)
  const customMaxSize = usePreviewStore(state => state.maxSize)
  const customBitrateMbps = usePreviewStore(state => state.bitrateMbps)
  const setQuality = usePreviewStore(state => state.setQuality)
  const setCustomFps = usePreviewStore(state => state.setCustomFps)
  const setCustomMaxSize = usePreviewStore(state => state.setCustomMaxSize)
  const setCustomBitrateMbps = usePreviewStore(state => state.setCustomBitrateMbps)
  const [settingsDirty, setSettingsDirty] = useState(false)

  const {
    automationAvailable,
    automationUnavailableMessage,
    infrastructureStatus,
    infrastructureStatusState,
    infrastructureLoading,
    infrastructureError,
    onRefreshInfrastructure,
    onInstall,
    onToggleServer,
    onToggleAgent,
  } = infrastructure
  const resolvedInfrastructureState = infrastructureStatusState || (infrastructureStatus ? 'ready' : 'loading')
  const infrastructureKnown = infrastructureStatus !== null && infrastructureStatus !== undefined
  const infrastructureBusy = infrastructureLoading !== null && infrastructureLoading !== undefined
  const previewBusy = infrastructureLoading === 'preview' || session.isConnecting
  const canDisconnect = session.mode !== 'off' || previewBusy || !['idle', 'disconnected'].includes(session.status)
  const unavailableInfrastructureLabel = resolvedInfrastructureState === 'loading' ? '检查中' : '未知'
  const componentStatusLabel = infrastructureKnown
    ? infrastructureStatus.built ? '已安装' : infrastructureStatus.installed ? '待构建' : '未安装'
    : unavailableInfrastructureLabel
  const serverStatusLabel = infrastructureKnown
    ? infrastructureStatus.serverRunning ? '运行中' : '已停止'
    : unavailableInfrastructureLabel
  const agentStatusLabel = infrastructureKnown
    ? infrastructureStatus.agentRunning ? '运行中' : '已停止'
    : unavailableInfrastructureLabel
  const serviceActions = [
    {
      key: 'server',
      label: infrastructureStatus?.serverRunning ? '停止服务' : '启动服务',
      icon: Server,
      onClick: onToggleServer,
      disabled: !infrastructureKnown || infrastructureBusy || (!infrastructureStatus?.serverRunning && !automationAvailable),
      allowWhenUnavailable: !!infrastructureStatus?.serverRunning,
      loading: infrastructureLoading === 'server',
    },
    {
      key: 'agent',
      label: infrastructureStatus?.agentRunning ? '停止 Agent' : '连接 Agent',
      icon: Smartphone,
      onClick: onToggleAgent,
      disabled: !infrastructureKnown || infrastructureBusy || (infrastructureStatus?.agentRunning ? false : !infrastructureStatus?.serverRunning || !automationAvailable),
      allowWhenUnavailable: !!infrastructureStatus?.agentRunning,
      loading: infrastructureLoading === 'agent',
    },
  ] as const

  const stats: [string, string | number][] = [
    ['信令', session.status],
    ['ICE', session.stats?.iceState || '--'],
    ['视频', session.stats?.videoLive ? 'live' : '--'],
    ['分辨率', session.stats?.width ? `${session.stats.width}×${session.stats.height}` : '--'],
    ['FPS', session.stats?.fps ?? '--'],
    ['码率', formatStatistic(session.stats?.bitrate, 'kbps')],
    ['网络 RTT', formatStatistic(session.stats?.rtt, 'ms')],
    ['触控', session.inputReady ? 'ready' : session.status === 'connected' ? '等待触控信息' : '--'],
  ]

  const applyPreset = (preset: QualityPreset) => {
    setQuality(preset)
    setSettingsDirty(true)
  }

  const reconnect = () => {
    if (!automationAvailable) return
    session.connect()
    setSettingsDirty(false)
  }

  return (
    <DialogFrame
      open={open}
      onOpenChange={onOpenChange}
      title="预览设置"
      size="lg"
      footer={(
        <DialogFrameFooter align="between">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="min-h-11"
              onClick={reconnect}
              disabled={!automationAvailable || infrastructureBusy}
              aria-busy={infrastructureLoading === 'preview' || undefined}
            >
              {infrastructureLoading === 'preview'
                ? <><LoaderCircle className="animate-spin" aria-hidden="true" />加载中···</>
                : <><RotateCw aria-hidden="true" />重连预览</>}
            </Button>
            {settingsDirty && (
              <span className="text-xs leading-5 text-primary">
                画质已修改，重连后生效
              </span>
            )}
          </div>
          <DialogClose render={<Button variant="outline" className="min-h-11" />}>
            关闭
          </DialogClose>
        </DialogFrameFooter>
      )}
    >
      <DialogBody className="flex flex-col gap-4">
        <section aria-labelledby={connectionHeadingId} className="flex flex-col gap-3">
          <h3 id={connectionHeadingId} className="flex items-center gap-2 text-sm font-medium">
            <Plug className="size-4 text-muted-foreground" aria-hidden="true" />
            连接与服务
          </h3>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
            <span className="text-xs text-muted-foreground">当前状态</span>
            <span className="flex min-w-0 items-center gap-2 text-xs font-medium">
              <span className={`preview-status-light is-${status.tone}`} aria-hidden="true" />
              <span className="truncate">{status.label}</span>
            </span>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">停止服务或 Agent 会断开其他观看者。</p>
          {infrastructureError && (
            <div role="alert" className="status-warning flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-xs leading-5">
              <span className="min-w-0 flex-1">{infrastructureError}</span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="min-h-11"
                onClick={onRefreshInfrastructure}
                disabled={!onRefreshInfrastructure}
              >
                刷新状态
              </Button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            {serviceActions.map(action => {
              const Icon = action.icon
              return (
                <Button
                  key={action.key}
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="min-h-11"
                  onClick={() => {
                    if (!action.onClick || (!automationAvailable && !action.allowWhenUnavailable)) return
                    void action.onClick()
                  }}
                  disabled={action.disabled}
                  title={action.disabled && !automationAvailable ? automationUnavailableMessage : undefined}
                >
                  <Icon aria-hidden="true" />
                  {action.loading ? '处理中' : action.label}
                </Button>
              )
            })}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11"
              onClick={session.disconnect}
              disabled={!canDisconnect}
            >
              <Unplug aria-hidden="true" />
              {previewBusy ? '取消启动' : '断开'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11"
              onClick={() => { void onInstall?.() }}
              disabled={!automationAvailable || infrastructureBusy || !infrastructureKnown}
              title={!automationAvailable ? automationUnavailableMessage : undefined}
            >
              <Package aria-hidden="true" />
              {infrastructureLoading === 'install' ? '安装中' : infrastructureStatus?.built ? '重装组件' : '安装组件'}
            </Button>
          </div>
        </section>

        <Separator />

        <section aria-labelledby={qualityHeadingId} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 id={qualityHeadingId} className="flex items-center gap-2 text-sm font-medium">
              <SlidersHorizontal className="size-4 text-muted-foreground" aria-hidden="true" />
              画质设置
            </h3>
            <span className="text-xs text-muted-foreground">
              {quality === 'custom' ? '自定义 · ' : ''}最长边 {customMaxSize}px · {customFps} FPS
            </span>
          </div>

          <div role="group" aria-label="画质预设" className="grid grid-cols-2 gap-1 rounded-lg bg-muted/60 p-1">
            {Object.entries(qualityPresets).map(([key, preset]) => (
              <button
                key={key}
                type="button"
                onClick={() => applyPreset(key as QualityPreset)}
                aria-pressed={quality === key}
                aria-label={`${preset.label}画质`}
                title={`最长边 ${preset.maxSize}px · ${preset.fps} FPS · 码率 ${preset.bitrateMbps} Mbps`}
                className={`flex min-h-11 flex-col items-start justify-center gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors ${quality === key ? 'bg-primary-soft text-primary-strong' : 'text-muted-foreground hover:bg-card hover:text-foreground'}`}
              >
                <span className="text-xs font-medium">{preset.label}</span>
                <small className="text-xs text-muted-foreground">{preset.maxSize}px · {preset.fps} FPS · {preset.bitrateMbps}M</small>
              </button>
            ))}
          </div>

          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">帧率</span>
            <div role="group" aria-label="视频帧率" className="grid grid-cols-4 gap-1 rounded-lg bg-muted/60 p-1">
              {fpsOptions.map(fps => (
                <button
                  key={fps}
                  type="button"
                  onClick={() => {
                    setCustomFps(fps)
                    setSettingsDirty(true)
                  }}
                  aria-pressed={customFps === fps}
                  aria-label={`${fps} FPS`}
                  className={`min-h-11 rounded-md text-xs font-medium transition-colors ${customFps === fps ? 'bg-primary-soft text-primary-strong' : 'text-muted-foreground hover:bg-card hover:text-foreground'}`}
                >
                  {fps}
                </button>
              ))}
            </div>
          </div>

          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            最长边
            <select
              aria-label="视频最长边"
              value={customMaxSize}
              className="control-surface min-h-11 rounded-lg px-3 text-foreground"
              onChange={event => {
                setCustomMaxSize(Number(event.target.value))
                setSettingsDirty(true)
              }}
            >
              {[640, 960, 1280, 1600, 1920].map(size => <option key={size} value={size}>{size}px</option>)}
            </select>
          </label>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Gauge className="size-3.5" aria-hidden="true" />码率
              </span>
              <output htmlFor={bitrateId} className="inline-flex items-baseline gap-1 text-xs text-muted-foreground">
                <strong className="text-sm font-bold text-foreground">{customBitrateMbps}</strong>
                <span>Mbps</span>
              </output>
            </div>
            <input
              id={bitrateId}
              type="range"
              min={1}
              max={32}
              step={0.5}
              value={customBitrateMbps}
              aria-label="视频码率"
              className="h-11 w-full accent-primary"
              onChange={(event) => {
                setCustomBitrateMbps(Number(event.target.value))
                setSettingsDirty(true)
              }}
            />
          </div>
        </section>

        <Separator />

        <section aria-labelledby={detailsHeadingId} className="flex flex-col gap-3">
          <h3 id={detailsHeadingId} className="flex items-center gap-2 text-sm font-medium">
            <Gauge className="size-4 text-muted-foreground" aria-hidden="true" />
            连接详情
          </h3>
          <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
            <span className="rounded-full bg-muted px-2 py-1">组件：{componentStatusLabel}</span>
            <span className="rounded-full bg-muted px-2 py-1">服务：{serverStatusLabel}</span>
            <span className="rounded-full bg-muted px-2 py-1">Agent：{agentStatusLabel}</span>
          </div>
          <div className="grid grid-cols-2 gap-1 rounded-lg border border-border p-1 text-xs sm:grid-cols-4">
            {stats.map(([label, value]) => (
              <div key={label} className="rounded-md px-2 py-1.5">
                <div className="text-muted-foreground">{label}</div>
                <div className="truncate font-medium text-foreground">{value}</div>
              </div>
            ))}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            连接详情仅在打开预览设置时采样；网络 RTT 为 ICE 往返时间，不含设备输入处理与画面反馈。快照模式每 {SNAPSHOT_INTERVAL_SECONDS}s 更新一次。
          </p>
        </section>
      </DialogBody>
    </DialogFrame>
  )
}
