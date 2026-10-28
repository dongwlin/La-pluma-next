import express from 'express';
import {
  clearRealtimeLogs,
  cleanupLogs,
  getDebugScreenshots,
  getLogFiles,
  getRealtimeLogs,
  readLogFile,
  MAX_REALTIME_LOG_LINES,
  MAX_LOG_FILE_LINES
} from '../services/maaService.js';
import {
  asyncHandler,
  agentError,
  sendSuccess,
  sendError
} from '../utils/apiHelper.ts';
import { resolveBoundedInteger } from '../utils/numericQueryHelper.js';

/**
 * 日志读取与维护路由。
 *
 * 读取只经 maaService 的日志边界：路径解码、目录越界判定与行数上限仍由该
 * 服务承担，路由只做 query 归一化。清空实时缓冲和按大小清理历史文件会改变
 * 运行数据，不是纯读取。文件名与行数上限的既有语义保持不变。
 */
const router = express.Router();

router.get('/logs/recent', asyncHandler(async (req, res) => {
  const lines = resolveBoundedInteger(req.query.lines, {
    defaultValue: 80,
    min: 1,
    max: MAX_REALTIME_LOG_LINES
  });
  return sendSuccess(res, req, getRealtimeLogs(lines));
}));

router.post('/logs/recent/clear', asyncHandler(async (req, res) => {
  clearRealtimeLogs();
  return sendSuccess(res, req, null, '实时日志已清空');
}));

router.get('/debug-screenshots', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, await getDebugScreenshots());
}));

router.get('/logs/files', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, await getLogFiles());
}));

router.get('/logs/files/*filePath', asyncHandler(async (req, res) => {
  // Express 5 命名通配符把捕获值作为路径段数组返回（如 ['sub', 'run.log']），
  // join 还原为相对路径后交给日志读取边界。
  const filePath = req.params.filePath.join('/');
  const lines = resolveBoundedInteger(req.query.lines, {
    defaultValue: 1000,
    min: 1,
    max: MAX_LOG_FILE_LINES
  });
  // Express 已对路径参数完成一次 URL 解码；这里不再二次解码，
  // 否则字面 %20 文件名会被错误转换，结尾为 % 的名字（如 100%.log）会抛 URIError。
  return sendSuccess(res, req, await readLogFile(filePath, lines));
}));

router.post('/logs/cleanup', asyncHandler(async (req, res) => {
  const maxSizeMB = Number(req.body?.maxSizeMB ?? 10);
  if (!Number.isFinite(maxSizeMB) || maxSizeMB < 1 || maxSizeMB > 1024) {
    return sendError(res, req, agentError(
      'AGENT_VALIDATION_LOG_SIZE_INVALID',
      '日志保留上限必须在 1 到 1024 MB 之间',
      { statusCode: 400, details: { maxSizeMB: req.body?.maxSizeMB } }
    ));
  }
  const result = await cleanupLogs(maxSizeMB);
  return sendSuccess(res, req, result, `已清理 ${result.deletedCount} 个日志文件，释放 ${(result.freedSpace / 1024 / 1024).toFixed(2)} MB 空间`);
}));

export default router;
