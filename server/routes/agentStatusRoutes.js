import express from 'express';
import { getMaaVersion } from '../services/maaExecutionService.js';
import { getRealtimeLogs, getTaskStatus } from '../services/maaProcessService.js';
import { getAgentRun } from '../services/agentRunService.ts';
import { buildAgentRunSnapshot, enrichAgentRun } from '../services/runSnapshotService.js';
import {
  asyncHandler,
  agentError,
  sendSuccess,
  sendError
} from '../utils/apiHelper.ts';
import { API_VERSION } from './agentContract.js';
import { resolveRequestConnection } from './requestConnection.js';
import { getAdbSummary, getAndroidDisplayState, getWebrtcSummary } from './deviceStatus.js';

/**
 * 状态与 Run 查询路由。
 *
 * `/status` 汇总 MAA 版本、任务状态、ADB、WebRTC 与设备显示状态；其中 ADB
 * 摘要会执行 `adb connect` 等现有探测，WebRTC 摘要会访问本地服务，因此不能
 * 按无副作用的纯读取端点处理，也不能用其探测结果推断设备空闲或执行成功。
 * `/runs/*` 只投影 agentRunService 与 runSnapshotService 的权威快照，不复制
 * 状态机，也不自行推断流程终态。
 */
const router = express.Router();

async function buildAgentStatus(req) {
  const connection = await resolveRequestConnection(req, { allowOverrides: true })
  const { adbPath, address } = connection
  const [version, adb, webrtc, orientation] = await Promise.all([
    getMaaVersion(true).catch(error => ({ error: error.message })),
    getAdbSummary(adbPath, address).catch(error => ({ connected: false, error: error.message, adbPath, address })),
    getWebrtcSummary(address, adbPath),
    getAndroidDisplayState(adbPath, address).catch(error => ({ error: error.message, adbPath, address }))
  ]);
  const task = getTaskStatus();
  const logs = getRealtimeLogs(25);
  const recommendations = [];

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

router.get('/status', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, await buildAgentStatus(req));
}));

router.get('/runs/current', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, await buildAgentRunSnapshot({ lines: req.query.lines }));
}));

router.get('/runs/:runId', asyncHandler(async (req, res) => {
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

router.get('/tasks/status', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, getTaskStatus());
}));

export default router;
