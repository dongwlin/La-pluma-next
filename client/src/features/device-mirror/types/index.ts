export interface WebrtcStatusData {
  installed?: boolean
  built?: boolean
  runtimeVersion?: string | null
  serverRunning?: boolean
  agentRunning?: boolean
  signalingUrl?: string
  directSignalingUrl?: string
  deviceId?: string
  devices?: string[]
  [key: string]: any
}
