import express from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import type { ReadRequest } from '../controllers/readDto.ts';
import type { LogFileRequest } from '../controllers/logDto.ts';
import * as agentLogController from '../controllers/agentLogController.ts';

/**
 * 日志读取与维护路由：只做端点映射。
 *
 * query 行数归一、文件路径 join 与 `/logs/cleanup` 的范围校验错误在
 * controllers/agentLogController.ts 构造，成功/失败 envelope 也由控制器
 * 装配；读取仍只经 maaLogFileService 的日志边界，实时缓冲的清空仍由
 * maaProcessService 承担。
 */
const router = express.Router();

router.get('/logs/recent', asyncHandler<ReadRequest, ApiResponseWriter>(agentLogController.readRecentLogs));

router.post('/logs/recent/clear', asyncHandler<ReadRequest, ApiResponseWriter>(agentLogController.clearRecentLogs));

router.get('/debug-screenshots', asyncHandler<ReadRequest, ApiResponseWriter>(agentLogController.readDebugScreenshots));

router.get('/logs/files', asyncHandler<ReadRequest, ApiResponseWriter>(agentLogController.readLogFiles));

router.get('/logs/files/*filePath', asyncHandler<LogFileRequest, ApiResponseWriter>(agentLogController.readLogFileByPath));

router.post('/logs/cleanup', asyncHandler<ReadRequest, ApiResponseWriter>(agentLogController.cleanupLogFiles));

export default router;
