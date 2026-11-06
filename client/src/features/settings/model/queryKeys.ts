import { defineQueryKeys } from '@/shared/query'

export const SETTINGS_DOMAIN = 'settings' as const

export const settingsKeys = defineQueryKeys(SETTINGS_DOMAIN)

export type SettingsResource = 'maa-config' | 'maa-instance-options' | 'resource-source' | 'version' | 'config-directory'
