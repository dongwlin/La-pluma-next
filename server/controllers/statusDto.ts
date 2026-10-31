/**
 * 状态 HTTP DTO
 *
 * `/status` 响应载荷：api 块（`la-pluma-agent-api` 兼容标识）是载荷的
 * 第一个键；状态探测失败时保留各自的兜底投影，不能互相替代。
 * `/runs/:runId` 的路径参数收窄为 RunLookupRequest；共享读取请求与助手
 * 仍由 readDto 提供。
 */

import type { AdbSummary, AndroidDisplayState, WebrtcSummary } from './deviceStatus.ts';
import type { MaaVersionInfo } from '../services/maaExecutionService.ts';
import type { MaaRealtimeLogEntry, MaaTaskStatus } from '../services/maaProcessService.ts';
import type { ReadRequest } from './readDto.ts';

/** `/runs/:runId`：路径参数由路由声明收窄为 string。 */
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

/** `/status` 的显示状态兜底。 */
export type OrientationStatusFailure = StatusProbeFailure;

/** 版本探测失败时的既有投影。 */
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
