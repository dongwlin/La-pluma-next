import { defineQueryKeys } from '@/shared/query'

export const AUTOMATION_DOMAIN = 'automation' as const

export const automationKeys = defineQueryKeys(AUTOMATION_DOMAIN)

export type AutomationResource = 'activity' | 'schedule-execution' | 'notification-config'
