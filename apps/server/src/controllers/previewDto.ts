import { DEFAULT_DEVICE_ID } from '../services/webrtcService.ts';
import type { CapturedScreen } from '../services/maaDeviceService.ts';
import type { ConnectionProfile } from '../services/connectionService.ts';
import type { WebrtcStatus } from '../services/webrtcService.ts';
import type { ApiErrorResponse, ApiRequestLike } from '../utils/apiHelper.ts';
import type { AndroidDisplayState } from './deviceStatus.ts';
import { resolveRequestConnection } from './requestConnection.ts';

/** 预览路由处理器的请求端口：query/body 保持 unknown，由本模块按端点收窄。 */
export interface PreviewRequest extends ApiRequestLike {
  body?: unknown;
  query?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function resolvePreviewConnection(request: PreviewRequest): Promise<ConnectionProfile> {
  return resolveRequestConnection(request, { allowOverrides: true });
}

/** `deviceId` 只接受非空字符串；缺省或非字符串沿用默认设备标识。 */
export function parseDeviceIdBody(body: unknown): string {
  const source = isRecord(body) ? body : {};
  const deviceId = source.deviceId;
  return typeof deviceId === 'string' && deviceId ? deviceId : DEFAULT_DEVICE_ID;
}

/** 方向请求：orientation 保持原始值，dryRun 保留旧实现的真值语义。 */
export interface PreviewOrientationInput {
  orientation: unknown;
  dryRun: boolean;
}

export function parseOrientationBody(body: unknown): PreviewOrientationInput {
  const source = isRecord(body) ? body : {};
  return {
    orientation: source.orientation,
    dryRun: Boolean(source.dryRun)
  };
}

export type PreviewOrientation = 'portrait' | 'landscape' | 'auto';

/** 同源浏览器预览协议：只公布本服务信令路径，不含上游管理端点。 */
export interface PreviewWebrtcProtocol {
  websocket: string;
  connectMessage: { message_type: 'connect'; device_id: string };
  requestOfferPayload: { type: 'request-offer'; ip_preference: 'ipv4' };
  candidatePolicy: string;
}

/** PNG 头解析结果；无法读取 IHDR 时宽高为 null。 */
export interface PngDimensions {
  width: number | null;
  height: number | null;
}

export interface PreviewScreenshotPayload extends CapturedScreen, PngDimensions {
  mediaType: 'image/png';
  adbPath: string;
  address: string;
  profileId: string;
}

export interface PreviewOrientationCommand {
  command: string;
  args: string[];
}

/** 方向设置计划；dryRun 直接返回该计划，不执行 ADB。 */
export interface PreviewOrientationPlan {
  action: 'preview-orientation';
  orientation: PreviewOrientation;
  adbPath: string;
  address: string;
  commands: PreviewOrientationCommand[];
}

/** 单条 ADB 命令结果；`cmd window` 失败按旧实现降级为 optional。 */
export interface PreviewOrientationCommandResult {
  ok: boolean;
  optional?: boolean;
  args: string[];
  stdout?: string;
  stderr?: string;
  error?: string;
}

/**
 * 方向应用后的显示观测：复用 deviceStatus 适配层的返回类型，
 * `inferredOrientation` 只会是 landscape/portrait/null。
 */
export type PreviewDisplayState = AndroidDisplayState;

export interface PreviewOrientationApplyResult extends PreviewOrientationPlan {
  results: PreviewOrientationCommandResult[];
  observed: PreviewDisplayState;
}

/** `/device-stats` 采样；任一 ADB 读取失败时整体为 null。 */
export interface PreviewDeviceStats {
  load1m: number | null;
  load5m: number | null;
  load15m: number | null;
  cpuPct: number | null;
  memTotalKb: number;
  memUsedKb: number;
  memFreeKb: number;
  memTotal: string;
  memUsed: string;
  memFree: string;
  memPct: number | null;
  swapTotalKb: number;
  swapUsedKb: number;
  diskTotal: string | null;
  diskUsed: string | null;
  diskFree: string | null;
  diskPct: number | null;
  temp: number | null;
}

/**
 * WebRTC 摘要：getWebrtcSummary 的探测快照加可达性与提示。
 * 上游状态探测失败时只保留 url 与布尔兜底，其余状态字段可能缺省，
 * 因此状态字段按 Partial 声明；预览路由不补造这些值。
 */
export interface WebrtcSummary extends Partial<WebrtcStatus> {
  url: string;
  reachable: boolean;
  serverRunning: boolean;
  agentRunning: boolean;
  installed: boolean;
  built: boolean;
  note: string;
}

export interface PreviewWebrtcStatusPayload extends WebrtcSummary {
  profileId: string;
  devices: string[];
}

export interface PreviewWebrtcDevicesPayload {
  devices: string[];
}

export interface PreviewWebrtcStartPayload extends PreviewWebrtcStatusPayload {
  deviceId: string;
  address: string;
  protocol: PreviewWebrtcProtocol;
}

export type PreviewErrorResponse = ApiErrorResponse;
