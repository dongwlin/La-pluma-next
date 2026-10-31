import express from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import type { ReadRequest } from '../controllers/readDto.ts';
import type { RunLookupRequest } from '../controllers/statusDto.ts';
import * as agentStatusController from '../controllers/agentStatusController.ts';

/**
 * 状态与 Run 查询路由：只做端点映射。
 *
 * `/status` 的 api 块（`la-pluma-agent-api` 兼容标识）由本控制器装配并保持
 * 对象第一个键，版本常量来自 config/apiVersion.ts；探测汇总、探测缓存与
 * `/runs/:runId` 的 404 映射在 controllers/agentStatusController.ts，响应
 * 结构显式建模在 statusDto。`/runs/current` 与 `/tasks/status` 只透传快照
 * 与任务状态服务；query 行数仍是单值，由快照层统一归一。
 */
const router = express.Router();

router.get('/status', asyncHandler<ReadRequest, ApiResponseWriter>(agentStatusController.readStatus));

router.get('/runs/current', asyncHandler<ReadRequest, ApiResponseWriter>(agentStatusController.readCurrentRun));

router.get('/runs/:runId', asyncHandler<RunLookupRequest, ApiResponseWriter>(agentStatusController.readRun));

router.get('/tasks/status', asyncHandler<ReadRequest, ApiResponseWriter>(agentStatusController.readTaskStatus));

export default router;
