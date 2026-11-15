import { toast } from 'sonner'
import { detectNoticeType, type NoticeType } from './noticeType'

export const EXECUTION_NOTICE_ID = 'execution'
export const STATISTICS_NOTICE_ID = 'statistics'
export const SETTINGS_UPDATE_NOTICE_ID = 'settings-update'

export interface NoticeOptions {
  id?: string
  duration?: number
}

export type Notify = (message: string, type?: NoticeType, options?: NoticeOptions) => string

const NOTICE_DURATION_MS: Record<NoticeType, number> = {
  success: 2500,
  error: Infinity,
  warning: 4000,
  info: 4000,
  default: 4000,
}

export function notify(message: string, type?: NoticeType, options: NoticeOptions = {}): string {
  if (!message) return ''

  const resolvedType = type ?? detectNoticeType(message)
  const duration = options.duration ?? NOTICE_DURATION_MS[resolvedType]
  const toastOptions = {
    duration,
    ...(options.id === undefined ? {} : { id: options.id }),
  }
  const id = resolvedType === 'default'
    ? toast(message, toastOptions)
    : toast[resolvedType](message, toastOptions)
  return String(id)
}

export function notifyProgress(message: string, id: string): string {
  return String(toast.loading(message, { id, duration: Infinity }))
}

export function dismissNotice(id?: string): void {
  toast.dismiss(id)
}
