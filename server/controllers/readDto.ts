/**
 * 读取 HTTP DTO
 *
 * 把 Express 的未知输入收窄成读取适配需要的类型；router 只做 HTTP 适配，
 * 运行状态、日志边界、掉落记录与游戏数据仍由各自服务所有者提供。
 *
 * 请求侧：
 * - 数值 query（`lines`/`days`）按单值读取：Express 5 对重复参数给出数组、
 *   对嵌套语法给出对象；路由不取首项也不展开，原样交给
 *   `resolveBoundedInteger`，保持“省略或非法值回落默认值、有限值截断并夹取”
 *   的既有语义。
 * - 日志文件路径是命名通配符：Express 5 把捕获值作为路径段数组返回，日志
 *   控制器以 `/` 连接后交给 maaLogFileService 的路径边界，单次解码语义不变。
 * - 清理请求的 `maxSizeMB` 只做 Number 归一；范围校验、错误码与错误详情
 *   （保留请求体原值）按既有语义在日志控制器构造，envelope 仍由路由层返回。
 *
 * 响应侧：状态汇总、掉落读取与游戏数据读取的载荷显式建模。状态探测失败时
 * 保留各自的兜底投影，不能互相替代；掉落服务返回统一 envelope，读取路由
 * 沿用旧实现的 `result.data || result` 真值选择，不重建成功/失败结构。
 */

import type {
  ApiErrorResponse,
  ApiRequestLike,
  ApiSuccessResponse
} from '../utils/apiHelper.ts';
import type { AdbSummary, AndroidDisplayState, WebrtcSummary } from './deviceStatus.ts';
import type { MaaVersionInfo } from '../services/maaExecutionService.ts';
import type { MaaRealtimeLogEntry, MaaTaskStatus } from '../services/maaProcessService.ts';

/** 读取路由处理器的请求端口：query/body 保持 unknown，由本模块按端点收窄。 */
export interface ReadRequest extends ApiRequestLike {
  body?: unknown;
  query?: unknown;
}

/** `/runs/:runId`：路径参数由路由声明收窄为 string。 */
export interface RunLookupRequest extends ReadRequest {
  params: { runId: string };
}

/** `/logs/files/*filePath`：命名通配符的捕获值是路径段数组。 */
export interface LogFileRequest extends ReadRequest {
  params: { filePath: string[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 读取单个数值 query 参数（`lines`/`days`）。
 *
 * 重复参数在 Express 中是数组、嵌套语法是对象；这里原样返回该值，由
 * `resolveBoundedInteger` 统一回落/截断/夹取，路由不复制归一规则。
 */
export function readNumericQuery(query: unknown, name: string): unknown {
  return isRecord(query) ? query[name] : undefined;
}

/** 探测失败时只保留 message 文本，不把堆栈带进响应。 */
export function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** 读取服务返回的统一 envelope；读取路由不重建成功/失败结构。 */
export type ReadResult<T> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * 掉落读取载荷：成功取 `data`，失败保留错误 envelope。
 * 保留旧实现的 `result.data || result` 真值选择，空值不会被误判成成功。
 */
export type ReadPayload<T> = T | ReadResult<T>;

export function unwrapReadPayload<T>(result: ReadResult<T>): ReadPayload<T> {
  return result.success && result.data ? result.data : result;
}

/** 成功与失败 envelope 都带 message；缺省仍回落“操作成功”。 */
export function readPayloadMessage(result: { message?: string }): string {
  return result.message || '操作成功';
}

/** 日志清理请求：requestedSize 保留请求体原值，用于既有错误详情。 */
export interface LogCleanupInput {
  requestedSize: unknown;
  maxSizeMB: number;
}

export function parseLogCleanupBody(body: unknown): LogCleanupInput {
  const requestedSize = isRecord(body) ? body.maxSizeMB : undefined;
  return { requestedSize, maxSizeMB: Number(requestedSize ?? 10) };
}
