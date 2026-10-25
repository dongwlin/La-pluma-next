/**
 * 设备发现与连接测试的 React 适配层
 *
 * 命令状态由模块级 `DeviceConnectionOwner` 持有；本 hook 只订阅状态并转发
 * 动作。Activity 隐藏或页面卸载时 cleanup 取消两条命令的本地等待，恢复后
 * 重新订阅并保留已完成的结果，不自动重发。
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import {
  settingsDeviceConnectionOwner,
  type ConnectionTestState,
  type DeviceConnectionOwner,
  type DeviceDiscoveryState,
  type DiscoveredDevice,
} from '../model/deviceConnection'

export interface UseSettingsDeviceConnectionResult {
  readonly discovery: DeviceDiscoveryState
  readonly test: ConnectionTestState
  readonly discover: (adbPath: string) => void
  readonly testConnection: (adbPath: string, address: string) => void
  readonly selectDevice: (device: DiscoveredDevice) => void
  readonly clearTestFeedback: () => void
}

export function useSettingsDeviceConnection(
  owner: DeviceConnectionOwner = settingsDeviceConnectionOwner,
): UseSettingsDeviceConnectionResult {
  const state = useSyncExternalStore(owner.subscribe, owner.getState, owner.getState)

  useEffect(() => () => owner.cancelAll(), [owner])

  const discover = useCallback((adbPath: string) => {
    void owner.discover(adbPath)
  }, [owner])

  const testConnection = useCallback((adbPath: string, address: string) => {
    void owner.test(adbPath, address)
  }, [owner])

  const selectDevice = useCallback((device: DiscoveredDevice) => {
    void owner.selectDiscoveredDevice(device)
  }, [owner])

  const clearTestFeedback = useCallback(() => {
    owner.clearTestFeedback()
  }, [owner])

  return {
    discovery: state.discovery,
    test: state.test,
    discover,
    testConnection,
    selectDevice,
    clearTestFeedback,
  }
}
