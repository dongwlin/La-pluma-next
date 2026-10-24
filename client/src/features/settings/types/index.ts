/**
 * 设置域类型
 */

import type { ReactNode } from 'react'

export interface MaaConnectionConfig {
  adb_path: string
  address: string
  config: string
  auto_reconnect?: boolean
}

export interface AutoUpdateConfig {
  enabled: boolean
  time: string
  updateCore: boolean
  updateCli: boolean
}

export interface ConfigSection {
  id: 'connection' | 'resource' | 'instance'
  name: string
  icon: ReactNode
}

export interface UpdateStatus {
  core: boolean
  cli: boolean
}
