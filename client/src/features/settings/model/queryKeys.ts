/**
 * 设置域 Query key
 *
 * 域标识 `settings` 与 feature 目录一致。FPR-024 只迁移 MAA profile 的
 * `maa-config` 读取；版本与配置目录仍由 FPR-025 接手，届时在同一工厂下
 * 增加 `version`、`config-directory` 资源，不另建域。
 */

import { defineQueryKeys } from '@/shared/query'

export const SETTINGS_DOMAIN = 'settings' as const

export const settingsKeys = defineQueryKeys(SETTINGS_DOMAIN)

export type SettingsResource = 'maa-config'
