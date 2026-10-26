/**
 * 总览今日流程卡
 *
 * 只渲染流程卡：执行投影、预检/启动反馈与开放关卡摘要。执行订阅和提交由
 * `useDashboardFlowActions` 复用领域所有者；卡片不直接调用 API、不写
 * `dashboardStore`，也不持有完整快照的刷新计时器。
 */

import { Activity, CalendarDays, CheckCircle2, Play, Target } from 'lucide-react'
import { Button, Card } from '@/shared/ui'
import { useDashboardStore } from '../store/dashboardStore'
import { useDashboardFlowActions } from '../hooks/useDashboardFlowActions'
import { buildDashboardFlowView } from '../model/flowView'

const labelClass = 'text-secondary'
const dashboardChipClass = 'brand-chip rounded-lg px-2.5 py-1 text-xs font-medium'
const mutedChipClass = 'rounded-lg px-2.5 py-1 surface-soft text-secondary text-xs'

interface DashboardFlowPanelProps {
  refreshDashboard: () => Promise<void>
  onMissingFlow: () => void
}

export default function DashboardFlowPanel({ refreshDashboard, onMissingFlow }: DashboardFlowPanelProps) {
  const activitySummary = useDashboardStore(state => state.activitySummary)
  const scheduleSummary = useDashboardStore(state => state.scheduleSummary)
  const openStageSummary = useDashboardStore(state => state.openStageSummary)
  const {
    status,
    isBusy,
    observationError,
    isAvailable,
    connectionTitle,
    connectionDescription,
    quickStartLoading,
    activityPreflightLoading,
    feedback,
    runTodayFlow,
    runCurrentActivity,
  } = useDashboardFlowActions({ refreshDashboard, onMissingFlow })

  const view = buildDashboardFlowView({
    automationAvailable: isAvailable,
    connectionTitle,
    connectionDescription,
    quickStartLoading,
    activityPreflightLoading,
    deviceBusy: isBusy,
    phase: status.phase,
    runLabel: status.label,
    runDetail: status.detail,
    currentTask: scheduleSummary.currentTask,
    scheduleMessage: scheduleSummary.message,
    observationError,
  })
  const activityCompleted = activitySummary.completion?.complete === true

  return (
    <div
      className={`dashboard-flow-glow-shell status-border-beam ${quickStartLoading || activityPreflightLoading || view.isRunning ? 'is-active' : ''}`}
      aria-busy={quickStartLoading || activityPreflightLoading || view.isRunning}
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
          <div className={`text-xs font-medium ${labelClass}`}>{view.statusLabel}</div>
          <div className="mt-0.5 truncate text-xl font-bold text-primary">{view.commandTitle}</div>
          <div className={`mt-1 truncate text-xs ${labelClass}`}>{view.commandDescription}</div>
        </div>
        <div className="dashboard-flow-actions">
          {activitySummary.available && (
            <Button
              onClick={runCurrentActivity}
              variant="secondary"
              disabled={view.controlsDisabled}
              loading={activityPreflightLoading}
              loadingText="检查中"
              statusKey={view.activityActionStatusKey}
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
            disabled={view.controlsDisabled}
            loading={quickStartLoading}
            loadingText="启动中"
            statusKey={view.primaryActionStatusKey}
            className="dashboard-flow-primary-action dashboard-flow-shining-action justify-center whitespace-nowrap"
            icon={<Play className="h-4 w-4" strokeWidth={2} />}
          >
            {view.primaryActionLabel}
          </Button>
        </div>
      </div>

      {feedback.message && (
        <div
          className={`dashboard-flow-message is-${feedback.type} text-xs`}
          data-dashboard-flow-feedback
        >
          <span className="dashboard-flow-message-dot" aria-hidden="true" />
          <span className="min-w-0 flex-1">{feedback.message}</span>
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
  )
}
