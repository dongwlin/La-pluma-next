import express from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import type { ReadRequest } from '../controllers/readDto.ts';
import type { LogFileRequest } from '../controllers/logDto.ts';
import * as agentLogController from '../controllers/agentLogController.ts';

const router = express.Router();

router.get('/logs/recent', asyncHandler<ReadRequest, ApiResponseWriter>(agentLogController.readRecentLogs));

router.post('/logs/recent/clear', asyncHandler<ReadRequest, ApiResponseWriter>(agentLogController.clearRecentLogs));

router.get('/debug-screenshots', asyncHandler<ReadRequest, ApiResponseWriter>(agentLogController.readDebugScreenshots));

router.get('/logs/files', asyncHandler<ReadRequest, ApiResponseWriter>(agentLogController.readLogFiles));

router.get('/logs/files/*filePath', asyncHandler<LogFileRequest, ApiResponseWriter>(agentLogController.readLogFileByPath));

router.post('/logs/cleanup', asyncHandler<ReadRequest, ApiResponseWriter>(agentLogController.cleanupLogFiles));

export default router;
