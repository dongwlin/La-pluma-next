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
import { agentError, sendSuccess, sendError } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import { resolveBoundedInteger } from '../utils/numericQueryHelper.ts';
import { readNumericQuery } from './readDto.ts';
import type { ReadRequest } from './readDto.ts';
import { parseLogCleanupBody } from './logDto.ts';
import type { LogFileRequest } from './logDto.ts';

export async function readRecentLogs(req: ReadRequest, res: ApiResponseWriter): Promise<void> {
  const lines = resolveBoundedInteger(readNumericQuery(req.query, 'lines'), {
    defaultValue: 80,
    min: 1,
    max: MAX_REALTIME_LOG_LINES
  });
  const payload: MaaRealtimeLogEntry[] = getRealtimeLogs(lines);
  return sendSuccess(res, req, payload);
}

export async function clearRecentLogs(req: ReadRequest, res: ApiResponseWriter): Promise<void> {
  clearRealtimeLogs();
  return sendSuccess(res, req, null, '实时日志已清空');
}

export async function readDebugScreenshots(req: ReadRequest, res: ApiResponseWriter): Promise<void> {
  const payload: MaaDebugScreenshot[] = await getDebugScreenshots();
  return sendSuccess(res, req, payload);
}

export async function readLogFiles(req: ReadRequest, res: ApiResponseWriter): Promise<void> {
  const payload: MaaLogFileEntry[] = await getLogFiles();
  return sendSuccess(res, req, payload);
}

export async function readLogFileByPath(req: LogFileRequest, res: ApiResponseWriter): Promise<void> {
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
}

/**
 * `/logs/cleanup` 的按大小清理与范围校验。
 *
 * maxSizeMB 越界时返回 `AGENT_VALIDATION_LOG_SIZE_INVALID`（400、details
 * 保留请求体原值）并交给 `sendError`；校验通过才调用 cleanupLogs
 * 改变运行数据，响应消息由清理结果推导。
 */
export async function cleanupLogFiles(req: ReadRequest, res: ApiResponseWriter): Promise<void> {
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
}
