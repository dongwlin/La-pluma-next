import { useCallback, useRef, useState } from 'react'
import { useStatusStore, type StatusMessageType } from '@/features/runtime-status'
import { loadUserConfig } from '@/features/user-config'
import { useDashboardExecution } from './useDashboardExecution'
import { useDashboardServiceStatus } from './useDashboardServiceStatus'

export interface DashboardFlowFeedback {
  readonly message: string
  readonly type: StatusMessageType
}

export interface DashboardFlowActionsOptions {
  refreshDashboard: () => Promise<void>
  onMissingFlow: () => void
}

export function useDashboardFlowActions({ refreshDashboard, onMissingFlow }: DashboardFlowActionsOptions) {
  const setStatusMessage = useStatusStore(state => state.setMessage)
  const { serviceStatus, isAvailable, connectionTitle, connectionDescription } = useDashboardServiceStatus()
  const {
    status,
    isBusy,
    observationError,
    startFlow,
    runActivity,
  } = useDashboardExecution({ notify: setStatusMessage })

  const [quickStartLoading, setQuickStartLoading] = useState(false)
  const [activityPreflightLoading, setActivityPreflightLoading] = useState(false)
  const [feedback, setFeedback] = useState<DashboardFlowFeedback>({ message: '', type: 'default' })
  // 点击可能在重渲染前重复触发：执行意图只允许一个在途，避免第二个提交或提前解锁。
  const quickStartInFlightRef = useRef(false)
  const activityPreflightInFlightRef = useRef(false)

  const unavailableMessage = serviceStatus === 'offline'
    ? '当前网络已断开，恢复连接后再试。'
    : '后端服务暂不可用，请重试连接。'

  const runTodayFlow = useCallback(async () => {
    if (quickStartInFlightRef.current) return
    if (!isAvailable) {
      setFeedback({ message: unavailableMessage, type: 'warning' })
      return
    }
    quickStartInFlightRef.current = true
    setQuickStartLoading(true)
    setFeedback({ message: '', type: 'info' })
    try {
      const configResult = await loadUserConfig('automation-tasks')
      const savedFlow = Array.isArray(configResult?.data?.taskFlow) ? configResult.data.taskFlow : []
      if (!configResult.success || savedFlow.length === 0) {
        setFeedback({ message: '还没有配置今日流程，先去日常页保存任务流。', type: 'warning' })
        onMissingFlow()
        return
      }

      const outcome = await startFlow(savedFlow)
      setFeedback({ message: outcome.message, type: outcome.type })
      if (outcome.ok) await refreshDashboard()
    } catch (error) {
      setFeedback({
        message: (error as Error)?.message || '今日流程启动失败',
        type: 'error',
      })
    } finally {
      quickStartInFlightRef.current = false
      setQuickStartLoading(false)
    }
  }, [isAvailable, onMissingFlow, refreshDashboard, startFlow, unavailableMessage])

  const runCurrentActivity = useCallback(async () => {
    if (activityPreflightInFlightRef.current) return
    if (!isAvailable) {
      setFeedback({ message: unavailableMessage, type: 'warning' })
      setStatusMessage(unavailableMessage, 'warning')
      return
    }
    const checkingMessage = '正在检查当前活动是否可以执行…'
    activityPreflightInFlightRef.current = true
    setActivityPreflightLoading(true)
    setFeedback({ message: checkingMessage, type: 'info' })
    setStatusMessage(checkingMessage, 'info')
    try {
      const outcome = await runActivity()
      if (outcome.executed) await refreshDashboard()
      setFeedback({ message: outcome.message, type: outcome.type })
      setStatusMessage(outcome.message, outcome.type)
    } catch (error) {
      const errorMessage = (error as Error)?.message || '当前活动检查失败'
      setFeedback({ message: errorMessage, type: 'error' })
      setStatusMessage(errorMessage, 'error')
    } finally {
      activityPreflightInFlightRef.current = false
      setActivityPreflightLoading(false)
    }
  }, [isAvailable, refreshDashboard, runActivity, setStatusMessage, unavailableMessage])

  return {
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
  }
}
