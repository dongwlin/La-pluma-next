/**
 * 预览 HTTP DTO
 *
 * 把 Express 的未知输入收窄成预览适配需要的类型；router 只做 HTTP 适配，
 * 不持有 WebRTC 进程、viewer 计时器或设备租约。
 * - 设备标识：请求体 `deviceId` 只接受非空字符串，其它值（空串、数值、
 *   对象）回退到 DEFAULT_DEVICE_ID；WebRTC 进程仍由 webrtcService 启动，
 *   路由不缓存设备状态。
 * - 方向：保留原始 orientation 值，由 buildOrientationPlan 沿用旧规则
 *   （`String(value || '').trim().toLowerCase()` 后只接受
 *   portrait/landscape/auto）校验；非法值仍以同一 400 错误返回，原始值
 *   进入 details。
 * - dryRun：沿用旧实现的真值判定（`Boolean`），既有输入的干跑/执行选择
 *   与之前一致。
 * - 连接选择：query 与 body 按既有顺序合并后交给 connectionService 的
 *   profile 解析，`allowOverrides` 保持 true；adbPath/address/profileId
 *   的覆盖优先级与响应字段不变。
 *
 * 响应类型只描述预览 router 自己拼装的载荷；截图内容来自
 * maaDeviceService，WebRTC 状态与设备列表来自 webrtcService，方向观测
 * 来自 deviceStatus，本模块不复制这些域的业务判定。错误响应沿用统一
 * 错误出口的信封（`AGENT_VALIDATION_ORIENTATION_INVALID`、
 * `AGENT_INTERNAL_ERROR` 等原样保留）。
 */

import { DEFAULT_DEVICE_ID } from '../services/webrtcService.ts';
import type { CapturedScreen } from '../services/maaDeviceService.ts';
import type { ConnectionProfile } from '../services/connectionService.ts';
import type { WebrtcStatus } from '../services/webrtcService.ts';
import type { ApiErrorResponse, ApiRequestLike } from '../utils/apiHelper.ts';
import type { AndroidDisplayState } from './deviceStatus.ts';
import { resolveRequestConnection } from './requestConnection.js';

/** 预览路由处理器的请求端口：query/body 保持 unknown，由本模块按端点收窄。 */
export interface PreviewRequest extends ApiRequestLike {
  body?: unknown;
  query?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 连接选择沿用请求级连接覆盖解析：query 与 body 合并后按 profile 解析，
 * 允许 adbPath/address/clientType 覆盖。
 */
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

/** 方向设置的有效输入；校验与错误细节仍由 buildOrientationPlan 决定。 */
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

/** `POST /screen/screenshot` 响应：截图内容加连接与尺寸元数据。 */
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

/** `POST /preview/orientation` 的已执行结果：计划、命令结果与观测。 */
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

/** `GET /webrtc/status` 响应：摘要加 profile 与设备列表。 */
export interface PreviewWebrtcStatusPayload extends WebrtcSummary {
  profileId: string;
  devices: string[];
}

/** `GET /webrtc/devices` 响应。 */
export interface PreviewWebrtcDevicesPayload {
  devices: string[];
}

/** `POST /webrtc/start` 响应：摘要、运行状态、连接与同源协议。 */
export interface PreviewWebrtcStartPayload extends PreviewWebrtcStatusPayload {
  deviceId: string;
  address: string;
  protocol: PreviewWebrtcProtocol;
}

/** 预览错误响应沿用统一错误出口的信封。 */
export type PreviewErrorResponse = ApiErrorResponse;
