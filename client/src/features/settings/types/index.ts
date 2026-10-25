/**
 * 设置域类型
 */

import type { ReactNode } from 'react'
import type { ConfigSectionId } from '../model/configSection'

export interface MaaConnectionConfig {
  adb_path: string
  address: string
  config: string
  auto_reconnect?: boolean
  /** MAA profile 的 connection 段可能包含本页不展示的选项，保存时原样回写。 */
  [key: string]: unknown
}

export interface AutoUpdateConfig {
  enabled: boolean
  time: string
  updateCore: boolean
  updateCli: boolean
}

export interface ConfigSection {
  id: ConfigSectionId
  name: string
  icon: ReactNode
}

export interface UpdateStatus {
  core: boolean
  cli: boolean
}
