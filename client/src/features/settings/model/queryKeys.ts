/**
 * 设置域 Query key
 *
 * 域标识 `settings` 与 feature 目录一致。FPR-024 迁移 MAA profile 的
 * `maa-config` 读取；FPR-025 在同一工厂下增加 `version`、`config-directory`
 * 资源。设备发现与连接测试是命令，不进入 Query。
 */

import { defineQueryKeys } from '@/shared/query'

export const SETTINGS_DOMAIN = 'settings' as const

export const settingsKeys = defineQueryKeys(SETTINGS_DOMAIN)

export type SettingsResource = 'maa-config' | 'version' | 'config-directory'
