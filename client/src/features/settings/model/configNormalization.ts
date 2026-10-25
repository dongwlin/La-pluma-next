/**
 * 设置域配置归一化模型
 *
 * 设置页包含两类可持久化配置：MAA profile 的 `connection` 段（显式保存）
 * 与 `auto-update` 用户配置（保存后应用调度）。服务端载荷、页面默认值与
 * 时间校验集中在这里，页面不再复制形状判断；自动更新的提交状态机仍由
 * 页面持有，FPR-026 再迁入更新用例所有者。
 *
 * `connection` 段保留服务端载荷中的未知字段：MAA profile 可能包含本页
 * 不展示的连接选项，保存时原样回写，不能因归一化丢字段。
 */

import { isRecord } from '@/shared/api'
import type { AutoUpdateConfig, MaaConnectionConfig } from '../types'

export const DEFAULT_CONNECTION_CONFIG: MaaConnectionConfig = {
  adb_path: '/opt/homebrew/bin/adb',
  address: '127.0.0.1:16384',
  config: 'CompatMac',
  auto_reconnect: true,
}

export const DEFAULT_AUTO_UPDATE_CONFIG: AutoUpdateConfig = {
  enabled: false,
  time: '04:00',
  updateCore: true,
  updateCli: true,
}

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
    auto_reconnect: typeof value.auto_reconnect === 'boolean'
      ? value.auto_reconnect
      : DEFAULT_CONNECTION_CONFIG.auto_reconnect,
  }
}

/** 比较整份 connection 草稿，包含服务端未知字段；undefined 与缺失等价。 */
export const connectionConfigsEqual = (
  left: MaaConnectionConfig,
  right: MaaConnectionConfig,
): boolean => {
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])
  for (const key of keys) {
    if (leftRecord[key] !== rightRecord[key]) return false
  }
  return true
}

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
