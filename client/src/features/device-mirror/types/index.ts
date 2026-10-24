/**
 * 投屏/截图预览域类型
 */

export interface WebrtcStatusData {
  installed?: boolean
  built?: boolean
  serverRunning?: boolean
  agentRunning?: boolean
  signalingUrl?: string
  directSignalingUrl?: string
  deviceId?: string
  devices?: string[]
  [key: string]: any
}
