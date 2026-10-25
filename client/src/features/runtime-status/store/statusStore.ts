import { create } from 'zustand'
import type { GlobalRunStatus } from '@/features/task-execution'
import { isRunStatusBusy } from '../utils/runStatus'
import { detectStatusMessageType, type StatusMessageType } from '../utils/statusMessage'

const AUTO_DISMISS_MS: Record<StatusMessageType, number> = {
  success: 1500,
  error: 0,
  warning: 3000,
  info: 10000,
  default: 3000,
}

/** 唯一快照尚未投影或投影为 `idle` 时的运行状态。 */
export const IDLE_RUN_STATUS: GlobalRunStatus = Object.freeze({
  phase: 'idle',
  isRunning: false,
  runId: null,
  label: null,
  detail: null,
})

let dismissTimer: ReturnType<typeof setTimeout> | null = null
let messageRevision = 0

const cancelDismissTimer = () => {
  if (!dismissTimer) return
  clearTimeout(dismissTimer)
  dismissTimer = null
}

const isSameRunStatus = (left: GlobalRunStatus, right: GlobalRunStatus) => (
  left.phase === right.phase
  && left.isRunning === right.isRunning
  && left.runId === right.runId
  && left.label === right.label
  && left.detail === right.detail
)

interface StatusState {
  message: string
  messageType: StatusMessageType | null
  /**
   * 全局运行状态，由 `useRunStatusProjection` 从执行控制器的唯一快照投影写入。
   * 页面、连接监测器和指示器都不得自行改写；这里只保留阶段、身份与一行标签，
   * 不复制 Run 记录。
   */
  runStatus: GlobalRunStatus
  backendStatus: 'unknown' | 'checking' | 'available' | 'unavailable'
  backendMessage: string
  setMessage: (message: string, type?: StatusMessageType) => number
  clearMessage: (expectedRevision?: number) => void
  applyRunStatus: (runStatus: GlobalRunStatus) => void
  setBackendStatus: (status: StatusState['backendStatus'], message?: string) => void
}

export const useStatusStore = create<StatusState>((set, get) => {
  const scheduleDismiss = (type: StatusMessageType, revision: number) => {
    cancelDismissTimer()
    if (isRunStatusBusy(get().runStatus)) return
    if (AUTO_DISMISS_MS[type] <= 0) return

    dismissTimer = setTimeout(() => {
      if (revision !== messageRevision || isRunStatusBusy(get().runStatus)) return
      dismissTimer = null
      set({ message: '', messageType: null })
    }, AUTO_DISMISS_MS[type])
  }

  return {
    message: '',
    messageType: null,
    runStatus: IDLE_RUN_STATUS,
    backendStatus: 'unknown',
    backendMessage: '',
    setMessage: (message, type) => {
      // Existing callers clear after their own delay. Ignore those stale clears;
      // the store owns dismissal so a previous operation cannot erase a newer one.
      if (!message) return messageRevision

      const revision = ++messageRevision
      const messageType = type ?? detectStatusMessageType(message)
      cancelDismissTimer()
      set({ message, messageType })
      scheduleDismiss(messageType, revision)
      return revision
    },
    clearMessage: (expectedRevision) => {
      if (expectedRevision !== undefined && expectedRevision !== messageRevision) return
      messageRevision += 1
      cancelDismissTimer()
      set({ message: '', messageType: null })
    },
    applyRunStatus: (runStatus) => {
      const previous = get().runStatus
      if (isSameRunStatus(previous, runStatus)) return

      const wasBusy = isRunStatusBusy(previous)
      set({ runStatus })
      if (isRunStatusBusy(runStatus)) {
        cancelDismissTimer()
        return
      }

      // 只有从忙到闲的转变才重新计时；重复上报空闲不能推迟已有消息的消失。
      if (!wasBusy) return
      const { message, messageType } = get()
      if (message && messageType) scheduleDismiss(messageType, messageRevision)
    },
    setBackendStatus: (backendStatus, backendMessage = '') => {
      set({ backendStatus, backendMessage })
    },
  }
})
