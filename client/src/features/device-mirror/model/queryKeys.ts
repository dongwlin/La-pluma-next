/**
 * 投屏/截图预览域 Query key
 *
 * 域标识 `device-mirror` 与 feature 目录一致；`device-stats` 是总览设备采样的
 * 只读资源，`webrtc-status` 预留给预览服务状态读取。采样不进入持久化缓存，
 * 页面隐藏或卸载后由 Query 注销观察者并停止轮询。
 */

import { defineQueryKeys } from '@/shared/query'

export const DEVICE_MIRROR_DOMAIN = 'device-mirror' as const

export const deviceMirrorKeys = defineQueryKeys(DEVICE_MIRROR_DOMAIN)

export type DeviceMirrorResource = 'webrtc-status' | 'device-stats'
