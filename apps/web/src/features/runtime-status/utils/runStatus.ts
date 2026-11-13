import type { GlobalRunStatus } from '@/features/task-execution'

/**
 * 设备是否忙：有活动 run（含等待继续），或被未纳管执行占用。
 * 断线时按最后一次已知值判断，避免一次失败就宣称空闲。
 */
export function isRunStatusBusy(status: GlobalRunStatus): boolean {
  return status.isRunning || status.phase === 'occupied'
}
