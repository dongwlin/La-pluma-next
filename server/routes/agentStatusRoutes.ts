import express from 'express';
import { getMaaVersion } from '../services/maaExecutionService.ts';
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
import { API_VERSION } from './agentContract.js';
import { resolveRequestConnection } from './requestConnection.js';
import { getAdbSummary, getAndroidDisplayState, getWebrtcSummary } from './deviceStatus.ts';
import { readErrorMessage, readNumericQuery } from './readDto.ts';
import type { AdbStatusFailure, AgentStatusPayload, ReadRequest, RunLookupRequest } from './readDto.ts';

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

async function buildAgentStatus(req: ReadRequest): Promise<AgentStatusPayload> {
  const connection = await resolveRequestConnection(req, { allowOverrides: true })
  const { adbPath, address } = connection
  const [version, adb, webrtc, orientation] = await Promise.all([
    getMaaVersion(true).catch(error => ({ error: readErrorMessage(error) })),
    getAdbSummary(adbPath, address).catch((error): AdbStatusFailure => ({ connected: false, error: readErrorMessage(error), adbPath, address })),
    getWebrtcSummary(address, adbPath),
    getAndroidDisplayState(adbPath, address).catch(error => ({ error: readErrorMessage(error), adbPath, address }))
  ]);
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
