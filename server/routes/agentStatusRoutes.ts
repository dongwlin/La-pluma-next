import express from 'express';
import { buildAgentRunSnapshot } from '../services/runSnapshotService.ts';
import { getTaskStatus } from '../services/maaProcessService.ts';
import {
  asyncHandler,
  sendSuccess,
  sendError
} from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import { API_VERSION } from './agentContract.ts';
import { readNumericQuery } from '../controllers/readDto.ts';
import type { ReadRequest } from '../controllers/readDto.ts';
import type { RunLookupRequest } from '../controllers/statusDto.ts';
import * as agentStatusController from '../controllers/agentStatusController.ts';

/**
 * 状态与 Run 查询路由：只做端点映射与 envelope 装配。
 *
 * `/status` 的 api 块（`la-pluma-agent-api` 兼容标识）由本文件装配并保持
 * 对象第一个键；探测汇总、探测缓存与 `/runs/:runId` 的 404 映射在
 * controllers/agentStatusController.ts，响应结构显式建模在 statusDto。
 * `/runs/current` 与 `/tasks/status` 只透传快照与任务状态服务；
 * query 行数仍是单值，由快照层统一归一。
 */
const router = express.Router();

router.get('/status', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, {
    api: {
      name: 'la-pluma-agent-api',
      version: API_VERSION,
      manifest: '/api/agent/manifest',
      openapi: '/api/agent/openapi.json'
    },
    ...await agentStatusController.buildStatus(req)
  });
}));

router.get('/runs/current', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await buildAgentRunSnapshot({ lines: readNumericQuery(req.query, 'lines') }));
}));

router.get('/runs/:runId', asyncHandler<RunLookupRequest, ApiResponseWriter>(async (req, res) => {
  const lookup = await agentStatusController.readRun(req.params.runId);
  if (!lookup.found) {
    return sendError(res, req, lookup.error);
  }
  return sendSuccess(res, req, lookup.run);
}));

router.get('/tasks/status', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, getTaskStatus());
}));

export default router;
