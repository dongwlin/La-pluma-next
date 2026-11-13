import { defineQueryKeys } from '@/shared/query'

export const DEVICE_MIRROR_DOMAIN = 'device-mirror' as const

export const deviceMirrorKeys = defineQueryKeys(DEVICE_MIRROR_DOMAIN)

export type DeviceMirrorResource = 'webrtc-status' | 'device-stats'
