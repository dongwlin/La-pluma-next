/**
 * 设置域 Query key
 *
 * 域标识 `settings` 与 feature 目录一致，资源 key 包括 MAA profile 的
 * `maa-config`、版本 `version` 与配置目录 `config-directory`。
 * 设备发现与连接测试是命令，不进入 Query。
 */

import { defineQueryKeys } from '@/shared/query'

export const SETTINGS_DOMAIN = 'settings' as const

export const settingsKeys = defineQueryKeys(SETTINGS_DOMAIN)

export type SettingsResource = 'maa-config' | 'version' | 'config-directory'
