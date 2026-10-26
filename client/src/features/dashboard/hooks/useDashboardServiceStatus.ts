/**
 * 总览的连接健康投影
 *
 * 只把 runtime-status 的 `backendStatus` 与浏览器在线状态映射成页面文案；
 * 连接探针仍由应用级 `useBackendStatusMonitor` 持有。连接提示与流程卡各自
 * 订阅所需切片，状态变化不会推动设备或摘要区域重渲染。
 */

import { useOnlineStatus } from '@/shared/hooks/useOnlineStatus'
import { useStatusStore } from '@/features/runtime-status'

export type DashboardServiceStatus = 'offline' | 'unknown' | 'checking' | 'available' | 'unavailable'

export interface DashboardServiceStatusView {
  readonly serviceStatus: DashboardServiceStatus
  readonly isAvailable: boolean
  readonly connectionTitle: string
  readonly connectionDescription: string
}

export function useDashboardServiceStatus(): DashboardServiceStatusView {
  const isOnline = useOnlineStatus()
  const backendStatus = useStatusStore(state => state.backendStatus)
  const backendMessage = useStatusStore(state => state.backendMessage)
  const serviceStatus: DashboardServiceStatus = isOnline ? backendStatus : 'offline'

  return {
    serviceStatus,
    isAvailable: serviceStatus === 'available',
    connectionTitle: serviceStatus === 'offline'
      ? '当前网络离线'
      : serviceStatus === 'unavailable'
        ? '后端服务不可用'
        : '正在检查服务',
    connectionDescription: serviceStatus === 'offline'
      ? '恢复网络连接后会自动重新检查服务'
      : serviceStatus === 'unavailable'
        ? (backendMessage || '确认 La Pluma Next 服务已启动后重试')
        : '正在确认自动化服务状态',
  }
}
