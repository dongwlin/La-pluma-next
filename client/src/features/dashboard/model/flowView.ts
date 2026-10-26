/**
 * 总览今日流程卡的展示投影
 *
 * 只把执行快照、加载态与连接健康映射成文案、按钮状态与忙碌标记，不读取
 * store、不发起请求、不持有定时器。完整快照与执行身份仍分别由
 * `snapshotRefresher`/`dashboardStore` 与 `useDashboardExecution` 持有。
 */

import type { GlobalRunPhase } from '@/features/task-execution'

export interface DashboardFlowViewInput {
  /** 后端可用且在线；不可用时禁止启动并展示连接说明。 */
  readonly automationAvailable: boolean
  readonly connectionTitle: string
  readonly connectionDescription: string
  readonly quickStartLoading: boolean
  readonly activityPreflightLoading: boolean
  /** 设备忙：有活动 run（含等待继续）或被未纳管执行占用。 */
  readonly deviceBusy: boolean
  readonly phase: GlobalRunPhase
  readonly runLabel?: string | null
  readonly runDetail?: string | null
  readonly currentTask?: string | null
  readonly scheduleMessage?: string | null
  readonly observationError?: string | null
}

export interface DashboardFlowView {
  readonly isRunning: boolean
  readonly controlsDisabled: boolean
  readonly statusLabel: '当前任务' | '当前操作' | '运行状态'
  readonly commandTitle: string
  readonly commandDescription: string
  readonly primaryActionLabel: '等待继续' | '正在运行' | '开始今日流程'
  readonly primaryActionStatusKey: 'starting' | 'running' | 'ready'
  readonly activityActionStatusKey: 'running' | 'ready'
}

export function buildDashboardFlowView({
  automationAvailable,
  connectionTitle,
  connectionDescription,
  quickStartLoading,
  activityPreflightLoading,
  deviceBusy,
  phase,
  runLabel,
  runDetail,
  currentTask,
  scheduleMessage,
  observationError,
}: DashboardFlowViewInput): DashboardFlowView {
  const isRunning = phase === 'running' || phase === 'waiting'
  const loading = quickStartLoading || activityPreflightLoading

  const statusLabel = automationAvailable && isRunning
    ? '当前任务'
    : loading
      ? '当前操作'
      : '运行状态'

  const commandTitle = !automationAvailable
    ? connectionTitle
    : activityPreflightLoading
      ? '正在检查当前活动'
      : quickStartLoading
        ? '正在启动今日流程'
        : phase === 'waiting'
          ? '等待继续'
          : phase === 'running'
            ? (runLabel || currentTask || '流程执行中')
            : phase === 'occupied'
              ? '设备被其他任务占用'
              : phase === 'unknown'
                ? '执行状态未知'
                : '准备就绪'

  const commandDescription = !automationAvailable
    ? connectionDescription
    : activityPreflightLoading
      ? '正在确认当前活动与可用作业'
      : quickStartLoading
        ? '正在读取任务配置并提交执行'
        : phase === 'waiting'
          ? '作业集等待下一关，请回到发起页面继续或停止'
          : phase === 'running'
            ? (runDetail || scheduleMessage || '自动化任务正在按计划推进')
            : phase === 'occupied'
              ? '设备被未纳管的执行占用，等待结束后再开始'
              : phase === 'unknown'
                ? (observationError || '暂时无法确认执行状态，恢复连接后会自动刷新')
                : (scheduleMessage || '设备待命，可以开始今天的自动化任务')

  return {
    isRunning,
    controlsDisabled: loading || deviceBusy || !automationAvailable,
    statusLabel,
    commandTitle,
    commandDescription,
    primaryActionLabel: phase === 'waiting'
      ? '等待继续'
      : isRunning
        ? '正在运行'
        : '开始今日流程',
    primaryActionStatusKey: quickStartLoading
      ? 'starting'
      : isRunning
        ? 'running'
        : 'ready',
    activityActionStatusKey: activityPreflightLoading ? 'running' : 'ready',
  }
}
