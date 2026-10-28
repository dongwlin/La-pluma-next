import express from 'express';
import { clearRealtimeLogs, getRealtimeLogs, MAX_REALTIME_LOG_LINES } from '../services/maaProcessService.ts';
import type { MaaRealtimeLogEntry } from '../services/maaProcessService.ts';
import {
  cleanupLogs,
  getDebugScreenshots,
  getLogFiles,
  readLogFile,
  MAX_LOG_FILE_LINES
} from '../services/maaLogFileService.ts';
import type {
  MaaDebugScreenshot,
  MaaLogCleanupResult,
  MaaLogFileContent,
  MaaLogFileEntry
} from '../services/maaLogFileService.ts';
import {
  asyncHandler,
  agentError,
  sendSuccess,
  sendError
} from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import { resolveBoundedInteger } from '../utils/numericQueryHelper.ts';
import { parseLogCleanupBody, readNumericQuery } from './readDto.ts';
import type { LogFileRequest, ReadRequest } from './readDto.ts';

/**
 * 日志读取与维护路由。
 *
 * 读取只经 maaLogFileService 的日志边界：路径解码、目录越界判定与行数
 * 上限仍由该服务承担；实时缓冲的清空由 maaProcessService 承担。路由只做
 * query 归一化。清空实时缓冲和按大小清理历史文件会改变运行数据，不是纯
 * 读取。文件名与行数上限的既有语义保持不变。
 *
 * 文件路径是 Express 5 命名通配符的路径段数组，join 还原为相对路径后交给
 * 日志边界；`lines` 仍是单值 query，重复参数与非法值由数值归一回落默认值。
 */
const router = express.Router();

router.get('/logs/recent', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  const lines = resolveBoundedInteger(readNumericQuery(req.query, 'lines'), {
    defaultValue: 80,
    min: 1,
    max: MAX_REALTIME_LOG_LINES
  });
  const payload: MaaRealtimeLogEntry[] = getRealtimeLogs(lines);
  return sendSuccess(res, req, payload);
}));

router.post('/logs/recent/clear', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  clearRealtimeLogs();
  return sendSuccess(res, req, null, '实时日志已清空');
}));

router.get('/debug-screenshots', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  const payload: MaaDebugScreenshot[] = await getDebugScreenshots();
  return sendSuccess(res, req, payload);
}));

router.get('/logs/files', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  const payload: MaaLogFileEntry[] = await getLogFiles();
  return sendSuccess(res, req, payload);
}));

router.get('/logs/files/*filePath', asyncHandler<LogFileRequest, ApiResponseWriter>(async (req, res) => {
  // Express 5 命名通配符把捕获值作为路径段数组返回（如 ['sub', 'run.log']），
  // join 还原为相对路径后交给日志读取边界。
  const filePath = req.params.filePath.join('/');
  const lines = resolveBoundedInteger(readNumericQuery(req.query, 'lines'), {
    defaultValue: 1000,
    min: 1,
    max: MAX_LOG_FILE_LINES
  });
  // Express 已对路径参数完成一次 URL 解码；这里不再二次解码，
  // 否则字面 %20 文件名会被错误转换，结尾为 % 的名字（如 100%.log）会抛 URIError。
  const payload: MaaLogFileContent = await readLogFile(filePath, lines);
  return sendSuccess(res, req, payload);
}));

router.post('/logs/cleanup', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  const { requestedSize, maxSizeMB } = parseLogCleanupBody(req.body);
  if (!Number.isFinite(maxSizeMB) || maxSizeMB < 1 || maxSizeMB > 1024) {
    return sendError(res, req, agentError(
      'AGENT_VALIDATION_LOG_SIZE_INVALID',
      '日志保留上限必须在 1 到 1024 MB 之间',
      { statusCode: 400, details: { maxSizeMB: requestedSize } }
    ));
  }
  const result: MaaLogCleanupResult = await cleanupLogs(maxSizeMB);
  return sendSuccess(res, req, result, `已清理 ${result.deletedCount} 个日志文件，释放 ${(result.freedSpace / 1024 / 1024).toFixed(2)} MB 空间`);
}));

export default router;
