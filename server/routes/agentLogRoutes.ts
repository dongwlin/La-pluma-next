import express from 'express';
import {
  asyncHandler,
  sendSuccess,
  sendError
} from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import type { ReadRequest } from '../controllers/readDto.ts';
import type { LogFileRequest } from '../controllers/logDto.ts';
import * as agentLogController from '../controllers/agentLogController.ts';

/**
 * 日志读取与维护路由：只做端点映射与 envelope 装配。
 *
 * query 行数归一、文件路径 join 与 `/logs/cleanup` 的范围校验在
 * controllers/agentLogController.ts；读取仍只经 maaLogFileService 的日志
 * 边界，实时缓冲的清空仍由 maaProcessService 承担。
 */
const router = express.Router();

router.get('/logs/recent', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await agentLogController.readRecentLogs(req));
}));

router.post('/logs/recent/clear', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  await agentLogController.clearRecentLogs();
  return sendSuccess(res, req, null, '实时日志已清空');
}));

router.get('/debug-screenshots', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await agentLogController.readDebugScreenshots());
}));

router.get('/logs/files', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await agentLogController.readLogFiles());
}));

router.get('/logs/files/*filePath', asyncHandler<LogFileRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await agentLogController.readLogFileByPath(req));
}));

router.post('/logs/cleanup', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  const outcome = await agentLogController.cleanupLogFiles(req);
  if (!outcome.ok) {
    return sendError(res, req, outcome.error);
  }
  return sendSuccess(res, req, outcome.result, outcome.message);
}));

export default router;
