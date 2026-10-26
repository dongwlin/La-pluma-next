import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Activity, CalendarDays, CheckCircle2, ChevronRight, Cpu, HardDrive, Database, PackageOpen, Play, ServerOff, Target, Thermometer, WifiOff } from 'lucide-react'
import Icons from '@/shared/ui/Icons'
import { PageHeader, Card, Button, IconButton, SmoothPanel } from '@/shared/ui'
import { DashboardSkeleton } from '../components/DashboardSkeleton'
import { FloatingStatusIndicator, useStatusStore, type StatusMessageType } from '@/features/runtime-status'
import { appTabRoute } from '@/shared/navigation'
import { useDashboardFlowLayout } from '../hooks/useDashboardFlowLayout'
import { useDashboardExecution } from '../hooks/useDashboardExecution'
import { useDashboardSnapshotRefresh } from '../hooks/useDashboardSnapshotRefresh'
import { useDashboardDeviceStats } from '../hooks/useDashboardDeviceStats'
import DashboardPreviewEntry from '../components/DashboardPreviewEntry'
import { loadUserConfig } from '@/features/user-config'
import { useOnlineStatus } from '@/shared/hooks/useOnlineStatus'
import { useDashboardStore } from '../store/dashboardStore'

const sectionTitleClass = 'text-base font-bold text-primary'
const labelClass = 'text-secondary'
const progressTrackClass = 'h-1.5 rounded-full bg-(--app-surface-muted) overflow-hidden'
const dashboardChipClass = 'brand-chip rounded-lg px-2.5 py-1 text-xs font-medium'
const mutedChipClass = 'rounded-lg px-2.5 py-1 surface-soft text-secondary text-xs'

const getUsageBarClass = (pct?: number | null) => {
  if (pct == null) return 'bg-(--app-accent)'
  if (pct >= 90) return 'bg-(--app-danger)'
  if (pct >= 75) return 'bg-(--app-warning)'
  return 'bg-(--app-accent)'
}

const getUsageValueClass = (pct?: number | null) => {
  if (pct == null) return 'text-primary'
  if (pct >= 90) return 'text-(--app-danger)'
  if (pct >= 75) return 'text-(--app-warning)'
  return 'text-primary'
}

const TemperatureSparkline = ({ values }: { values: number[] }) => {
  const chartValues = values.length > 1 ? values : values.length === 1 ? [values[0]!, values[0]!] : []
  if (chartValues.length === 0) {
    return <div className="dashboard-temperature-empty">等待温度采样</div>
  }

  const min = Math.min(...chartValues)
  const max = Math.max(...chartValues)
  const isStable = max - min < 0.1
  const chartMin = isStable ? min - 1 : min
  const chartMax = isStable ? max + 1 : max
  const spread = chartMax - chartMin
  const points = chartValues.map((value, index) => {
    const x = chartValues.length === 1 ? 0 : (index / (chartValues.length - 1)) * 100
    const y = 25 - ((value - chartMin) / spread) * 18
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  const areaPoints = `0,28 ${points} 100,28`
  const lastPoint = points.split(' ').slice(-1)[0]?.split(',')

  return (
    <div className="dashboard-temperature-chart" aria-label={`最近温度 ${min.toFixed(1)} 到 ${max.toFixed(1)} 摄氏度`}>
      <svg viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="dashboard-temperature-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--app-accent)" stopOpacity="0.2" />
            <stop offset="100%" stopColor="var(--app-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1="0" y1="14" x2="100" y2="14" className="dashboard-temperature-gridline" />
        <polygon points={areaPoints} fill="url(#dashboard-temperature-fill)" />
        <polyline points={points} className="dashboard-temperature-line" />
        <circle cx={lastPoint?.[0]} cy={lastPoint?.[1]} r="1.6" className="dashboard-temperature-dot" />
      </svg>
      <div className="dashboard-temperature-range">
        <span>{min.toFixed(0)}°</span>
        <span>近 {Math.max(5, (values.length - 1) * 5)} 秒</span>
        <span>{max.toFixed(0)}°</span>
      </div>
    </div>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const {
    backendStatus,
    backendMessage,
    setMessage: setStatusMessage,
  } = useStatusStore()
  const isOnline = useOnlineStatus()
  const openAutomation = useCallback(() => navigate(appTabRoute('automation')), [navigate])
  const {
    status: runStatus,
    isBusy: deviceBusy,
    observationError,
    startFlow,
    runActivity,
  } = useDashboardExecution({ notify: setStatusMessage })
  const hasLoaded = useDashboardStore(state => state.hasLoaded)
  const activitySummary = useDashboardStore(state => state.activitySummary)
  const scheduleSummary = useDashboardStore(state => state.scheduleSummary)
  const trainingSummary = useDashboardStore(state => state.trainingSummary)
  const dropSummary = useDashboardStore(state => state.dropSummary)
  const openStageSummary = useDashboardStore(state => state.openStageSummary)
  const deviceStats = useDashboardStore(state => state.deviceStats)
  const temperatureHistory = useDashboardStore(state => state.temperatureHistory)
  const { refreshDashboard: loadDashboardData } = useDashboardSnapshotRefresh()
  useDashboardDeviceStats()
  const { flowGridRef, flowCardRef, flowPreviewRef, flowGridStyle } = useDashboardFlowLayout(hasLoaded)
  const [quickStartLoading, setQuickStartLoading] = useState(false)
  const [activityPreflightLoading, setActivityPreflightLoading] = useState(false)
  // 点击可能在重渲染前重复触发：执行意图只允许一个在途，避免第二个提交或提前解锁。
  const quickStartInFlightRef = useRef(false)
  const activityPreflightInFlightRef = useRef(false)
  const [quickStartMessage, setQuickStartMessage] = useState('')
  const [quickStartMessageType, setQuickStartMessageType] = useState<StatusMessageType>('default')

  const serviceStatus = isOnline ? backendStatus : 'offline'
  const automationAvailable = serviceStatus === 'available'

  const runTodayFlow = async () => {
    if (quickStartInFlightRef.current) return
    if (!automationAvailable) {
      setQuickStartMessage(serviceStatus === 'offline' ? '当前网络已断开，恢复连接后再试。' : '后端服务暂不可用，请重试连接。')
      setQuickStartMessageType('warning')
      return
    }
    quickStartInFlightRef.current = true
    setQuickStartLoading(true)
    setQuickStartMessage('')
    setQuickStartMessageType('info')
    try {
      const configResult = await loadUserConfig('automation-tasks')
      const savedFlow = Array.isArray(configResult?.data?.taskFlow) ? configResult.data.taskFlow : []
      if (!configResult.success || savedFlow.length === 0) {
        setQuickStartMessage('还没有配置今日流程，先去日常页保存任务流。')
        setQuickStartMessageType('warning')
        navigate(appTabRoute('automation'))
        return
      }

      const outcome = await startFlow(savedFlow)
      setQuickStartMessage(outcome.message)
      setQuickStartMessageType(outcome.type)
      if (outcome.ok) await loadDashboardData()
    } catch (error: any) {
      setQuickStartMessage(error?.message || '今日流程启动失败')
      setQuickStartMessageType('error')
    } finally {
      quickStartInFlightRef.current = false
      setQuickStartLoading(false)
    }
  }

  const runCurrentActivity = async () => {
    if (activityPreflightInFlightRef.current) return
    if (!automationAvailable) {
      const unavailableMessage = serviceStatus === 'offline'
        ? '当前网络已断开，恢复连接后再试。'
        : '后端服务暂不可用，请重试连接。'
      setQuickStartMessage(unavailableMessage)
      setQuickStartMessageType('warning')
      setStatusMessage(unavailableMessage, 'warning')
      return
    }
    const checkingMessage = '正在检查当前活动是否可以执行…'
    activityPreflightInFlightRef.current = true
    setActivityPreflightLoading(true)
    setQuickStartMessage(checkingMessage)
    setQuickStartMessageType('info')
    setStatusMessage(checkingMessage, 'info')
    try {
      const outcome = await runActivity()
      if (outcome.executed) await loadDashboardData()
      setQuickStartMessage(outcome.message)
      setQuickStartMessageType(outcome.type)
      setStatusMessage(outcome.message, outcome.type)
    } catch (error: any) {
      const errorMessage = error?.message || '当前活动检查失败'
      setQuickStartMessage(errorMessage)
      setQuickStartMessageType('error')
      setStatusMessage(errorMessage, 'error')
    } finally {
      activityPreflightInFlightRef.current = false
      setActivityPreflightLoading(false)
    }
  }

  if (!hasLoaded) {
    return <DashboardSkeleton />
  }

  const flowIsRunning = runStatus.phase === 'running' || runStatus.phase === 'waiting'
  const flowControlsDisabled = quickStartLoading
    || activityPreflightLoading
    || deviceBusy
    || !automationAvailable
  const connectionTitle = serviceStatus === 'offline'
    ? '当前网络离线'
    : serviceStatus === 'unavailable'
      ? '后端服务不可用'
      : '正在检查服务'
  const connectionDescription = serviceStatus === 'offline'
    ? '恢复网络连接后会自动重新检查服务'
    : serviceStatus === 'unavailable'
      ? (backendMessage || '确认 La Pluma Next 服务已启动后重试')
      : '正在确认自动化服务状态'
  const flowCommandTitle = !automationAvailable
    ? connectionTitle
    : activityPreflightLoading
      ? '正在检查当前活动'
      : quickStartLoading
        ? '正在启动今日流程'
        : runStatus.phase === 'waiting'
          ? '等待继续'
          : runStatus.phase === 'running'
            ? (runStatus.label || scheduleSummary.currentTask || '流程执行中')
            : runStatus.phase === 'occupied'
              ? '设备被其他任务占用'
              : runStatus.phase === 'unknown'
                ? '执行状态未知'
                : '准备就绪'
  const flowCommandDescription = !automationAvailable
    ? connectionDescription
    : activityPreflightLoading
      ? '正在确认当前活动与可用作业'
      : quickStartLoading
        ? '正在读取任务配置并提交执行'
        : runStatus.phase === 'waiting'
          ? '作业集等待下一关，请回到发起页面继续或停止'
          : runStatus.phase === 'running'
            ? (runStatus.detail || scheduleSummary.message || '自动化任务正在按计划推进')
            : runStatus.phase === 'occupied'
              ? '设备被未纳管的执行占用，等待结束后再开始'
              : runStatus.phase === 'unknown'
                ? (observationError || '暂时无法确认执行状态，恢复连接后会自动刷新')
                : (scheduleSummary.message || '设备待命，可以开始今天的自动化任务')
  const activityCompleted = activitySummary.completion?.complete === true

  return (
    <div className="app-page dashboard-page" data-page="dashboard">
      <div className="app-stack-section">
        <PageHeader
          title="概览"
          subtitle="当前活动、自动化进度、养成与掉落总览"
          mobileLayout="inline"
          actions={
            <div className="dashboard-page-actions flex w-full items-center sm:w-auto">
              <div className="dashboard-status-slot min-w-0 flex-1 sm:flex-none">
                <FloatingStatusIndicator className="dashboard-status-indicator w-full sm:w-auto" textClassName="truncate whitespace-nowrap" />
              </div>
            </div>
          }
        />

        {(serviceStatus === 'offline' || serviceStatus === 'unavailable') && (
          <SmoothPanel
            cornerSize="compact"
            className="dashboard-connection-alert"
            surfaceClassName={`app-info-card flex min-w-0 flex-wrap items-center gap-3 ${serviceStatus === 'offline' ? 'status-warning' : 'status-danger'}`}
            role="alert"
          >
            {serviceStatus === 'offline'
              ? <WifiOff className="h-5 w-5 shrink-0" aria-hidden="true" />
              : <ServerOff className="h-5 w-5 shrink-0" aria-hidden="true" />}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">{connectionTitle}</div>
              <div className="mt-0.5 text-xs opacity-80">{connectionDescription}</div>
            </div>
            {serviceStatus === 'unavailable' && (
              <Button
                onClick={() => loadDashboardData()}
                variant="secondary"
                size="sm"
                icon={<Icons.RefreshCw />}
              >
                重试连接
              </Button>
            )}
          </SmoothPanel>
        )}

        <div
          ref={flowGridRef}
          className="dashboard-flow-layout"
          style={flowGridStyle}
        >
          <div ref={flowCardRef} className="min-w-0">
            <div
              className={`dashboard-flow-glow-shell status-border-beam ${quickStartLoading || activityPreflightLoading || flowIsRunning ? 'is-active' : ''}`}
              aria-busy={quickStartLoading || activityPreflightLoading || flowIsRunning}
            >
              <Card smoothCorners className="dashboard-flow-card p-0!">
              <div className="dashboard-flow-header">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="dashboard-flow-mark" aria-hidden="true">
                    <Activity className="h-4 w-4" strokeWidth={1.8} />
                  </div>
                  <div className="min-w-0">
                    <div className="dashboard-flow-title text-base font-bold text-primary">今日流程</div>
                  </div>
                </div>
              </div>

              <div className="dashboard-flow-command">
                <div className="min-w-0">
                  <div className={`text-xs font-medium ${labelClass}`}>
                    {automationAvailable && flowIsRunning
                      ? '当前任务'
                      : activityPreflightLoading || quickStartLoading
                        ? '当前操作'
                        : '运行状态'}
                  </div>
                  <div className="mt-0.5 truncate text-xl font-bold text-primary">{flowCommandTitle}</div>
                  <div className={`mt-1 truncate text-xs ${labelClass}`}>{flowCommandDescription}</div>
                </div>
                <div className="dashboard-flow-actions">
                  {activitySummary.available && (
                    <Button
                      onClick={runCurrentActivity}
                      variant="secondary"
                      disabled={flowControlsDisabled}
                      loading={activityPreflightLoading}
                      loadingText="检查中"
                      statusKey={activityPreflightLoading ? 'running' : 'ready'}
                      className={`dashboard-flow-activity-action justify-center whitespace-nowrap ${activityCompleted ? 'is-completed' : ''}`}
                      title={activityCompleted ? '重新执行当前活动' : '检查活动导航并执行已保存偏好的活动作业'}
                      aria-label={activityCompleted ? '重新执行当前活动' : '打当前活动'}
                      icon={activityCompleted
                        ? <CheckCircle2 className="h-4 w-4" strokeWidth={2} />
                        : <Target className="h-4 w-4" strokeWidth={2} />}
                    >
                      {activityCompleted ? (
                        <>
                          <span className="dashboard-flow-activity-completed-label">活动已通关</span>
                          <span className="dashboard-flow-activity-run-label">打当前活动</span>
                        </>
                      ) : '打当前活动'}
                    </Button>
                  )}
                  <Button
                    onClick={runTodayFlow}
                    variant="primary"
                    disabled={flowControlsDisabled}
                    loading={quickStartLoading}
                    loadingText="启动中"
                    statusKey={quickStartLoading ? 'starting' : flowIsRunning ? 'running' : 'ready'}
                    className="dashboard-flow-primary-action dashboard-flow-shining-action justify-center whitespace-nowrap"
                    icon={<Play className="h-4 w-4" strokeWidth={2} />}
                  >
                    {runStatus.phase === 'waiting' ? '等待继续' : flowIsRunning ? '正在运行' : '开始今日流程'}
                  </Button>
                </div>
              </div>

              {quickStartMessage && (
                <div
                  className={`dashboard-flow-message is-${quickStartMessageType} text-xs`}
                  data-dashboard-flow-feedback
                >
                  <span className="dashboard-flow-message-dot" aria-hidden="true" />
                  <span className="min-w-0 flex-1">{quickStartMessage}</span>
                </div>
              )}

              <div className="dashboard-flow-activity">
                <div className="flex items-center gap-2">
                  <CalendarDays className="h-3.5 w-3.5 text-(--app-accent-strong)" strokeWidth={1.8} aria-hidden="true" />
                  <span className={`text-xs font-medium ${labelClass}`}>当前活动</span>
                </div>
                <div className="mt-2 wrap-break-word text-sm font-bold text-primary">
                  {activitySummary.available ? (activitySummary.name || activitySummary.code || '进行中') : '暂无活动'}
                </div>
                <div className={`mt-0.5 wrap-break-word text-xs ${labelClass}`}>{activitySummary.tip || '等待活动数据'}</div>
              </div>

              <div className="dashboard-flow-stages">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="dashboard-flow-rail-dot" />
                    <span className="text-xs font-semibold text-primary">今日开放关卡</span>
                  </div>
                  <span className={`text-[11px] ${labelClass}`}>{openStageSummary.open.length} 个日常本</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {openStageSummary.open.length > 0 ? (
                    openStageSummary.open.map(item => (
                      <span key={item.stage} className={dashboardChipClass}>{item.stage} · {item.name}</span>
                    ))
                  ) : (
                    <span className={mutedChipClass}>等待开放关卡数据</span>
                  )}
                </div>
              </div>

              </Card>
            </div>
          </div>

          <div ref={flowPreviewRef} className="min-w-0">
            <DashboardPreviewEntry onOpen={openAutomation} />
          </div>
        </div>

        {deviceStats && (
          <div className="dashboard-device-section">
            <div className="flex items-center gap-2">
              <div className="h-0.5 flex-1 bg-(--app-border) rounded-full" />
              <span className={`text-xs font-medium ${labelClass} uppercase shrink-0`}>设备状态</span>
              <div className="h-0.5 flex-1 bg-(--app-border) rounded-full" />
            </div>
            <div className="dashboard-device-grid">
              {([
                { label: 'CPU', pct: deviceStats.cpuPct, sub: deviceStats.load1m != null ? `负载 ${deviceStats.load1m.toFixed(1)}` : '', Icon: Cpu, value: undefined as string | undefined },
                { label: '内存', pct: deviceStats.memPct, sub: `${deviceStats.memUsed ?? '--'} / ${deviceStats.memTotal ?? '--'}`, Icon: Database, value: undefined as string | undefined },
                { label: '磁盘', pct: deviceStats.diskPct, sub: `${deviceStats.diskUsed ?? '--'} / ${deviceStats.diskTotal ?? '--'}`, Icon: HardDrive, value: undefined as string | undefined },
                { label: '温度', pct: undefined, sub: '', Icon: Thermometer, value: deviceStats.temp != null ? `${deviceStats.temp}°C` : '--' },
              ] as const).map(({ label, pct, sub, Icon, value }) => {
                return (
                  <SmoothPanel
                    key={label}
                    cornerSize="compact"
                    className="dashboard-device-card-shell group surface-panel-hover transition-colors"
                    surfaceClassName="dashboard-device-card"
                  >
                    <div className="flex items-center gap-2.5 mb-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center text-tertiary">
                        <Icon className={`h-4 w-4 ${labelClass}`} strokeWidth={1.5} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-primary">{label}</div>
                        <div className={`truncate text-xs ${labelClass}`}>{sub || '实时采样'}</div>
                      </div>
                      {value != null && (
                        <div className="ml-auto text-sm font-semibold text-primary">{value}</div>
                      )}
                    </div>
                    {label === '温度' ? (
                      <TemperatureSparkline values={temperatureHistory} />
                    ) : pct != null && (
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className={`text-xs ${labelClass}`}>使用率</span>
                          <span className={`text-xs font-medium ${getUsageValueClass(pct)}`}>{pct}%</span>
                        </div>
                        <div className={progressTrackClass}>
                          <div className={`h-full rounded-full transition-all duration-700 ${getUsageBarClass(pct)}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                        </div>
                      </div>
                    )}
                  </SmoothPanel>
                )
              })}
            </div>
          </div>
        )}

        <div className="dashboard-summary-grid">
          <Card smoothCorners className="dashboard-summary-card is-training p-0!">
            <div className="dashboard-summary-header">
              <div className="dashboard-summary-heading">
                <span className="dashboard-summary-icon" aria-hidden="true">
                  <Target className="h-4 w-4" strokeWidth={1.8} />
                </span>
                <div className="min-w-0">
                  <div className={sectionTitleClass}>养成摘要</div>
                </div>
              </div>
              <IconButton
                onClick={() => navigate(appTabRoute('training'))}
                icon={<ChevronRight className="h-4 w-4" />}
                variant="ghost"
                size="sm"
                title="打开养成"
                aria-label="打开养成"
                className="dashboard-summary-action"
              />
            </div>
            <div className="dashboard-summary-body">
              <div className="dashboard-summary-statline">
                <div>
                  <div className="dashboard-summary-number">{trainingSummary.count}</div>
                  <div className="dashboard-summary-number-label">培养目标</div>
                </div>
                <div className="dashboard-summary-copy">
                  <div className="text-sm font-semibold text-primary">{trainingSummary.count > 0 ? '队列已建立' : '等待添加目标'}</div>
                  <div className="dashboard-summary-detail">
                    {trainingSummary.count > 0 ? '按优先级推进当前培养计划' : '添加干员后会在这里汇总优先目标'}
                  </div>
                </div>
              </div>
              <div className={`dashboard-summary-footer${trainingSummary.topNames.length === 0 ? ' is-action' : ''}`}>
                {trainingSummary.topNames.length > 0 ? (
                  <div className="dashboard-stage-list">
                    {trainingSummary.topNames.map(name => (
                      <span key={name} className="dashboard-stage-chip is-accent">{name}</span>
                    ))}
                  </div>
                ) : (
                  <button type="button" onClick={() => navigate(appTabRoute('training'))} className="dashboard-summary-link min-h-11">
                    添加首个培养目标
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          </Card>

          <Card smoothCorners className="dashboard-summary-card is-drops p-0!">
            <div className="dashboard-summary-header">
              <div className="dashboard-summary-heading">
                <span className="dashboard-summary-icon" aria-hidden="true">
                  <PackageOpen className="h-4 w-4" strokeWidth={1.8} />
                </span>
                <div className="min-w-0">
                  <div className={sectionTitleClass}>今日掉落摘要</div>
                </div>
              </div>
              <IconButton
                onClick={() => navigate(appTabRoute('statistics'))}
                icon={<ChevronRight className="h-4 w-4" />}
                variant="ghost"
                size="sm"
                title="打开数据"
                aria-label="打开数据"
                className="dashboard-summary-action"
              />
            </div>
            <div className="dashboard-summary-body">
              <div className="dashboard-summary-statline">
                <div>
                  <div className="dashboard-summary-number">{dropSummary.count}</div>
                  <div className="dashboard-summary-number-label">掉落记录</div>
                </div>
                <div className="dashboard-summary-copy">
                  <div className="text-sm font-semibold text-primary">{dropSummary.count > 0 ? '今日已记录' : '尚无作战产出'}</div>
                  <div className="dashboard-summary-detail">
                    {dropSummary.count > 0 ? '最近的关卡与材料已完成汇总' : '完成作战后会自动记录关卡与材料'}
                  </div>
                </div>
              </div>
              <div className={`dashboard-summary-footer${dropSummary.count === 0 ? ' is-action' : ''}`}>
                {dropSummary.count > 0 ? (
                  <div className="dashboard-drop-list">
                    {dropSummary.recent.map((record, index) => (
                      <div key={`${record.stage}-${index}`} className="dashboard-drop-row">
                        <span className="dashboard-drop-stage">{record.stage}</span>
                        <span className="dashboard-drop-items">{record.items}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <button type="button" onClick={() => navigate(appTabRoute('statistics'))} className="dashboard-summary-link min-h-11">
                    查看掉落数据
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          </Card>
        </div>

      </div>
    </div>
  )
}
