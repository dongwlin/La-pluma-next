import express from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import type { ReadRequest } from '../controllers/readDto.ts';
import type { RunLookupRequest } from '../controllers/statusDto.ts';
import * as agentStatusController from '../controllers/agentStatusController.ts';

const router = express.Router();

router.get('/status', asyncHandler<ReadRequest, ApiResponseWriter>(agentStatusController.readStatus));

router.get('/runs/current', asyncHandler<ReadRequest, ApiResponseWriter>(agentStatusController.readCurrentRun));

router.get('/runs/:runId', asyncHandler<RunLookupRequest, ApiResponseWriter>(agentStatusController.readRun));

router.get('/tasks/status', asyncHandler<ReadRequest, ApiResponseWriter>(agentStatusController.readTaskStatus));

export default router;
