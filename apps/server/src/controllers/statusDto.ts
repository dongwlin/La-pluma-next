import type { AdbSummary, AndroidDisplayState, WebrtcSummary } from './deviceStatus.ts';
import type { MaaVersionInfo } from '../services/maaExecutionService.ts';
import type { MaaRealtimeLogEntry, MaaTaskStatus } from '../services/maaProcessService.ts';
import type { ReadRequest } from './readDto.ts';

export interface RunLookupRequest extends ReadRequest {
  params: { runId: string };
}

/** 状态探测失败时的既有兜底投影：不能当作设备空闲或连接成功。 */
export interface StatusProbeFailure {
  error: string;
  adbPath: string;
  address: string;
}

/** `/status` 的 ADB 兜底：探测异常也保持 connected=false。 */
export interface AdbStatusFailure extends StatusProbeFailure {
  connected: false;
}

export type OrientationStatusFailure = StatusProbeFailure;

export interface MaaVersionFailure {
  error: string;
}

/** `/status` 响应：Run、进程、设备与屏幕投影并列，任一失败不影响其它投影。 */
export interface AgentStatusPayload {
  api: {
    name: 'la-pluma-agent-api';
    version: string;
    manifest: string;
    openapi: string;
  };
  maa: {
    version: MaaVersionInfo | MaaVersionFailure;
    task: MaaTaskStatus;
  };
  device: AdbSummary | AdbStatusFailure;
  screen: {
    webrtc: WebrtcSummary;
    orientation: AndroidDisplayState | OrientationStatusFailure;
  };
  recentLogs: MaaRealtimeLogEntry[];
  recommendations: string[];
}
