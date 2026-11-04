import { getMaaVersion } from '../services/maaExecutionService.ts';
import type { MaaVersionInfo } from '../services/maaExecutionService.ts';
import { getRealtimeLogs, getTaskStatus } from '../services/maaProcessService.ts';
import { getAgentRun } from '../services/agentRunService.ts';
import { buildAgentRunSnapshot, enrichAgentRun } from '../services/runSnapshotService.ts';
import type { AgentRunSnapshotEntry } from '../services/runSnapshotService.ts';
import { agentError, sendSuccess, sendError } from '../utils/apiHelper.ts';
import type { AgentError, ApiResponseWriter } from '../utils/apiHelper.ts';
import { API_VERSION } from '../config/apiVersion.ts';
import { resolveRequestConnection } from './requestConnection.ts';
import { getAdbSummary, getAndroidDisplayState, getWebrtcSummary } from './deviceStatus.ts';
import type { AdbSummary, AndroidDisplayState, WebrtcSummary } from './deviceStatus.ts';
import { readErrorMessage, readNumericQuery } from './readDto.ts';
import type { ReadRequest } from './readDto.ts';
import type {
  AdbStatusFailure,
  AgentStatusPayload,
  MaaVersionFailure,
  OrientationStatusFailure,
  RunLookupRequest
} from './statusDto.ts';

/** 四项外部探测的短 TTL：轮询突发共享结果，设备变化最迟约 1.5 秒后重新探测。 */
const STATUS_PROBE_CACHE_TTL = 1500;

interface StatusProbes {
  version: MaaVersionInfo | MaaVersionFailure;
  adb: AdbSummary | AdbStatusFailure;
  webrtc: WebrtcSummary;
  orientation: AndroidDisplayState | OrientationStatusFailure;
}

interface CachedStatusProbes {
  timestamp: number;
  probes: StatusProbes;
}

const statusProbeCache = new Map<string, CachedStatusProbes>();
const statusProbeRequests = new Map<string, Promise<StatusProbes>>();

/** 响应会携带 adbPath；同一 address 下不同 ADB 路径不能共用探测结果。 */
function statusProbeKey(adbPath: string, address: string): string {
  return `${address}\u0000${adbPath}`;
}

/**
 * 合并 `/status` 的并发设备探测。
 *
 * `/status` 一次汇总会启动 MAA 版本、ADB、dumpsys、lsof/ps 等多个外部进程；
 * 前端轮询与多客户端同时请求会成倍放大。这里只缓存四项外部探测，任务状态与
 * 日志仍每次读取最新值。失败投影也进入短缓存，离线设备不会在每次轮询重复
 * 等待同一批超时。
 */
async function readStatusProbes(adbPath: string, address: string): Promise<StatusProbes> {
  const key = statusProbeKey(adbPath, address);
  const cached = statusProbeCache.get(key);
  if (cached && Date.now() - cached.timestamp < STATUS_PROBE_CACHE_TTL) return cached.probes;

  const pending = statusProbeRequests.get(key);
  if (pending) return pending;

  let request: Promise<StatusProbes>;
  request = Promise.all([
    getMaaVersion(true).catch((error): MaaVersionFailure => ({ error: readErrorMessage(error) })),
    getAdbSummary(adbPath, address).catch((error): AdbStatusFailure => ({ connected: false, error: readErrorMessage(error), adbPath, address })),
    getWebrtcSummary(address, adbPath),
    getAndroidDisplayState(adbPath, address).catch((error): OrientationStatusFailure => ({ error: readErrorMessage(error), adbPath, address }))
  ]).then(([version, adb, webrtc, orientation]) => {
    const probes: StatusProbes = { version, adb, webrtc, orientation };
    statusProbeCache.set(key, { timestamp: Date.now(), probes });
    return probes;
  }).finally(() => {
    if (statusProbeRequests.get(key) === request) statusProbeRequests.delete(key);
  });
  statusProbeRequests.set(key, request);
  return request;
}

export function resetAgentStatusProbeCacheForTests(): void {
  statusProbeCache.clear();
  statusProbeRequests.clear();
}

export type AgentStatusBody = Omit<AgentStatusPayload, 'api'>;

export type AgentRunLookup =
  | { found: true; run: AgentRunSnapshotEntry }
  | { found: false; error: AgentError };

/**
 * `/status` 的探测汇总与建议投影。
 *
 * 只做业务载荷：任务状态与实时日志每次读取最新值，四项外部探测走上面的
 * 合并与短缓存；建议列表按既有规则由设备、任务与 WebRTC 状态推导。
 */
export async function buildStatus(req: ReadRequest): Promise<AgentStatusBody> {
  const connection = await resolveRequestConnection(req, { allowOverrides: true })
  const { adbPath, address } = connection
  const { version, adb, webrtc, orientation } = await readStatusProbes(adbPath, address);
  const task = getTaskStatus();
  const logs = getRealtimeLogs(25);
  const recommendations: string[] = [];

  if (!adb.connected) recommendations.push(`ADB 未连接：检查模拟器和 ${address}`);
  if (task.isRunning) recommendations.push('MAA 当前有任务运行，避免并发启动新任务');
  if (!webrtc.reachable) recommendations.push('WebRTC 实时预览未启动，可启动 WebRTC 服务');
  if (adb.connected && !task.isRunning) recommendations.push('可以执行 start-game 或 run-task');

  return {
    maa: {
      version,
      task
    },
    device: adb,
    screen: {
      webrtc,
      orientation
    },
    recentLogs: logs,
    recommendations
  };
}

/**
 * `/runs/:runId` 的 Run 查询与 404 映射。
 *
 * 未命中权威 Run 存储时返回 `AGENT_RUN_NOT_FOUND`（404、携带 runId 详情、
 * 不可重试），由 readRun handler 交给 `sendError`；命中时返回 enriched 快照。
 */
async function lookupRun(runId: string): Promise<AgentRunLookup> {
  const run = getAgentRun(runId);
  if (!run) {
    return {
      found: false,
      error: agentError('AGENT_RUN_NOT_FOUND', `未找到 Agent run: ${runId}`, {
        statusCode: 404,
        details: { runId },
        retryable: false
      })
    };
  }
  return { found: true, run: enrichAgentRun(run) };
}

/** `/status`：api 块保持对象第一个键，探测汇总随后展开。 */
export async function readStatus(req: ReadRequest, res: ApiResponseWriter): Promise<void> {
  return sendSuccess(res, req, {
    api: {
      name: 'la-pluma-agent-api',
      version: API_VERSION,
      manifest: '/api/agent/manifest',
      openapi: '/api/agent/openapi.json'
    },
    ...await buildStatus(req)
  });
}

export async function readCurrentRun(req: ReadRequest, res: ApiResponseWriter): Promise<void> {
  return sendSuccess(res, req, await buildAgentRunSnapshot({ lines: readNumericQuery(req.query, 'lines') }));
}

export async function readRun(req: RunLookupRequest, res: ApiResponseWriter): Promise<void> {
  const lookup = await lookupRun(req.params.runId);
  if (!lookup.found) {
    return sendError(res, req, lookup.error);
  }
  return sendSuccess(res, req, lookup.run);
}

export async function readTaskStatus(req: ReadRequest, res: ApiResponseWriter): Promise<void> {
  return sendSuccess(res, req, getTaskStatus());
}
