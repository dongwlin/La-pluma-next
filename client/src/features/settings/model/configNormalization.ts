// 服务端载荷、页面默认值与时间校验集中在这里；connection 段必须保留服务端载荷中的
// 未知字段（MAA profile 可能含本页不展示的选项），显式保存按整份快照回写。

import { isRecord } from '@/shared/api'
import {
  MAA_CONNECTION_PRESETS,
  MAA_TOUCH_MODES,
  type AutoUpdateConfig,
  type MaaConnectionConfig,
  type MaaConnectionPreset,
  type MaaInstanceOptions,
  type MaaTouchMode,
} from '../types'

export const DEFAULT_CONNECTION_CONFIG: MaaConnectionConfig = {
  adb_path: '/opt/homebrew/bin/adb',
  address: '127.0.0.1:16384',
  config: 'CompatMac',
  preset: 'ADB',
  auto_reconnect: true,
}

export const DEFAULT_INSTANCE_OPTIONS: MaaInstanceOptions = {
  touch_mode: 'Adb',
  deployment_with_pause: false,
  adb_lite_enabled: false,
  kill_adb_on_exit: false,
}

export const DEFAULT_AUTO_UPDATE_CONFIG: AutoUpdateConfig = {
  enabled: false,
  time: '04:00',
  updateCore: true,
  updateCli: true,
}

export const isMaaConnectionPreset = (value: unknown): value is MaaConnectionPreset => (
  typeof value === 'string' && (MAA_CONNECTION_PRESETS as readonly string[]).includes(value)
)

export const isMaaTouchMode = (value: unknown): value is MaaTouchMode => (
  typeof value === 'string' && (MAA_TOUCH_MODES as readonly string[]).includes(value)
)

/**
 * 归一化 MAA profile 的 connection 段。
 *
 * - 非对象载荷返回 `null`，由调用方决定报错或回退本地草稿；
 * - 已知字段类型不合法时使用页面原有默认值；
 * - 未知字段原样保留，显式保存按整份 connection 快照回写。
 */
export const normalizeConnectionConfig = (value: unknown): MaaConnectionConfig | null => {
  if (!isRecord(value)) return null

  return {
    ...value,
    adb_path: typeof value.adb_path === 'string' ? value.adb_path : DEFAULT_CONNECTION_CONFIG.adb_path,
    address: typeof value.address === 'string' ? value.address : DEFAULT_CONNECTION_CONFIG.address,
    config: typeof value.config === 'string' ? value.config : DEFAULT_CONNECTION_CONFIG.config,
    preset: isMaaConnectionPreset(value.preset) ? value.preset : DEFAULT_CONNECTION_CONFIG.preset,
    auto_reconnect: typeof value.auto_reconnect === 'boolean'
      ? value.auto_reconnect
      : DEFAULT_CONNECTION_CONFIG.auto_reconnect,
  }
}

/**
 * 归一化 MAA profile 的 instance_options 段；缺失或类型不合法字段使用 MaaCore
 * 默认值（ADB 触控、不暂停部署、关闭 AdbLite、退出不结束 ADB），未知字段保留。
 */
export const normalizeInstanceOptionsConfig = (value: unknown): MaaInstanceOptions | null => {
  if (!isRecord(value)) return null

  return {
    ...value,
    touch_mode: isMaaTouchMode(value.touch_mode) ? value.touch_mode : DEFAULT_INSTANCE_OPTIONS.touch_mode,
    deployment_with_pause: typeof value.deployment_with_pause === 'boolean'
      ? value.deployment_with_pause
      : DEFAULT_INSTANCE_OPTIONS.deployment_with_pause,
    adb_lite_enabled: typeof value.adb_lite_enabled === 'boolean'
      ? value.adb_lite_enabled
      : DEFAULT_INSTANCE_OPTIONS.adb_lite_enabled,
    kill_adb_on_exit: typeof value.kill_adb_on_exit === 'boolean'
      ? value.kill_adb_on_exit
      : DEFAULT_INSTANCE_OPTIONS.kill_adb_on_exit,
  }
}

/** 比较整份配置草稿，包含服务端未知字段；undefined 与缺失等价。 */
export const configRecordsEqual = (
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean => {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (left[key] !== right[key]) return false
  }
  return true
}

export const connectionConfigsEqual = configRecordsEqual

/**
 * 归一化自动更新设置。非对象载荷返回 `null`；缺失或类型不合法字段沿用
 * 页面原有默认值。该形状与本地 `autoUpdateConfig` 回退格式一致。
 */
export const normalizeAutoUpdateConfig = (value: unknown): AutoUpdateConfig | null => {
  if (!isRecord(value)) return null

  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_AUTO_UPDATE_CONFIG.enabled,
    time: typeof value.time === 'string' ? value.time : DEFAULT_AUTO_UPDATE_CONFIG.time,
    updateCore: typeof value.updateCore === 'boolean' ? value.updateCore : DEFAULT_AUTO_UPDATE_CONFIG.updateCore,
    updateCli: typeof value.updateCli === 'boolean' ? value.updateCli : DEFAULT_AUTO_UPDATE_CONFIG.updateCli,
  }
}

/** 校验自动更新时间是否为 00:00–23:59 的 `HH:MM`。 */
export const isValidUpdateTime = (value: string): boolean => {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return false
  return Number(match[1]) <= 23 && Number(match[2]) <= 59
}
