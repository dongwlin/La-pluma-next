import express from 'express';
import { getMaaVersion } from '../services/maaExecutionService.ts';
import type { MaaVersionInfo } from '../services/maaExecutionService.ts';
import { getRealtimeLogs, getTaskStatus } from '../services/maaProcessService.ts';
import { getAgentRun } from '../services/agentRunService.ts';
import { buildAgentRunSnapshot, enrichAgentRun } from '../services/runSnapshotService.ts';
import {
  asyncHandler,
  agentError,
  sendSuccess,
  sendError
} from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import { API_VERSION } from './agentContract.ts';
import { resolveRequestConnection } from '../controllers/requestConnection.ts';
import { getAdbSummary, getAndroidDisplayState, getWebrtcSummary } from '../controllers/deviceStatus.ts';
import type { AdbSummary, AndroidDisplayState, WebrtcSummary } from '../controllers/deviceStatus.ts';
import { readErrorMessage, readNumericQuery } from '../controllers/readDto.ts';
import type {
  AdbStatusFailure,
  AgentStatusPayload,
  MaaVersionFailure,
  OrientationStatusFailure,
  ReadRequest,
  RunLookupRequest
} from '../controllers/readDto.ts';

/**
 * 状态与 Run 查询路由。
 *
 * `/status` 汇总 MAA 版本、任务状态、ADB、WebRTC 与设备显示状态；其中 ADB
 * 摘要会执行 `adb connect` 等现有探测，WebRTC 摘要会访问本地服务，因此不能
 * 按无副作用的纯读取端点处理，也不能用其探测结果推断设备空闲或执行成功。
 * `/runs/*` 只投影 agentRunService 与 runSnapshotService 的权威快照，不复制
 * 状态机，也不自行推断流程终态。
 *
 * 各探测失败时保留自己的兜底投影（版本、ADB、显示状态互不替代），
 * 响应结构显式建模在 readDto；query 行数仍是单值，由快照层统一归一。
 */
const router = express.Router();

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

/** 测试清理进程内探测缓存；生产调用无副作用。 */
export function resetAgentStatusProbeCacheForTests(): void {
  statusProbeCache.clear();
  statusProbeRequests.clear();
}

async function buildAgentStatus(req: ReadRequest): Promise<AgentStatusPayload> {
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
    api: {
      name: 'la-pluma-agent-api',
      version: API_VERSION,
      manifest: '/api/agent/manifest',
      openapi: '/api/agent/openapi.json'
    },
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

router.get('/status', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await buildAgentStatus(req));
}));

router.get('/runs/current', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await buildAgentRunSnapshot({ lines: readNumericQuery(req.query, 'lines') }));
}));

router.get('/runs/:runId', asyncHandler<RunLookupRequest, ApiResponseWriter>(async (req, res) => {
  const run = getAgentRun(req.params.runId);
  if (!run) {
    return sendError(res, req, agentError('AGENT_RUN_NOT_FOUND', `未找到 Agent run: ${req.params.runId}`, {
      statusCode: 404,
      details: { runId: req.params.runId },
      retryable: false
    }));
  }
  return sendSuccess(res, req, enrichAgentRun(run));
}));

router.get('/tasks/status', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, getTaskStatus());
}));

export default router;
