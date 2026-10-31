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
import { agentError } from '../utils/apiHelper.ts';
import type { AgentError } from '../utils/apiHelper.ts';
import { resolveBoundedInteger } from '../utils/numericQueryHelper.ts';
import { readNumericQuery } from './readDto.ts';
import type { ReadRequest } from './readDto.ts';
import { parseLogCleanupBody } from './logDto.ts';
import type { LogFileRequest } from './logDto.ts';

/**
 * 日志读取与维护控制器。
 *
 * 读取只经 maaLogFileService 的日志边界：路径解码、目录越界判定与行数
 * 上限仍由该服务承担；实时缓冲的清空由 maaProcessService 承担。控制器只做
 * query 归一化。清空实时缓冲和按大小清理历史文件会改变运行数据，不是纯
 * 读取。文件名与行数上限的既有语义保持不变。
 *
 * 文件路径是 Express 5 命名通配符的路径段数组，join 还原为相对路径后交给
 * 日志边界；`lines` 仍是单值 query，重复参数与非法值由数值归一回落默认值。
 *
 * 控制器只返回业务载荷：成功/失败 envelope 由路由层的 sendSuccess /
 * sendError 统一封装；`/logs/cleanup` 的范围校验错误经判别联合交回路由。
 */

/** `/logs/recent` 的实时日志读取：行数缺省 80，上限为进程缓冲的既有上限。 */
export async function readRecentLogs(req: ReadRequest): Promise<MaaRealtimeLogEntry[]> {
  const lines = resolveBoundedInteger(readNumericQuery(req.query, 'lines'), {
    defaultValue: 80,
    min: 1,
    max: MAX_REALTIME_LOG_LINES
  });
  const payload: MaaRealtimeLogEntry[] = getRealtimeLogs(lines);
  return payload;
}

/** `/logs/recent/clear`：清空实时缓冲，属改变运行数据的维护动作。 */
export async function clearRecentLogs(): Promise<void> {
  clearRealtimeLogs();
}

/** `/debug-screenshots`：调试截图清单读取。 */
export async function readDebugScreenshots(): Promise<MaaDebugScreenshot[]> {
  const payload: MaaDebugScreenshot[] = await getDebugScreenshots();
  return payload;
}

/** `/logs/files`：日志文件清单读取。 */
export async function readLogFiles(): Promise<MaaLogFileEntry[]> {
  const payload: MaaLogFileEntry[] = await getLogFiles();
  return payload;
}

/** `/logs/files/*filePath` 的日志内容读取：行数缺省 1000，上限为日志边界上限。 */
export async function readLogFileByPath(req: LogFileRequest): Promise<MaaLogFileContent> {
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
  return payload;
}

/** `/logs/cleanup` 的清理出口：校验通过时携带清理结果与响应消息，越界时携带 400 错误。 */
export type LogCleanupOutcome =
  | { ok: true; result: MaaLogCleanupResult; message: string }
  | { ok: false; error: AgentError };

/**
 * `/logs/cleanup` 的按大小清理与范围校验。
 *
 * maxSizeMB 越界时返回 `AGENT_VALIDATION_LOG_SIZE_INVALID`（400、details
 * 保留请求体原值），由路由层交给 `sendError`；校验通过才调用 cleanupLogs
 * 改变运行数据，响应消息由清理结果推导。
 */
export async function cleanupLogFiles(req: ReadRequest): Promise<LogCleanupOutcome> {
  const { requestedSize, maxSizeMB } = parseLogCleanupBody(req.body);
  if (!Number.isFinite(maxSizeMB) || maxSizeMB < 1 || maxSizeMB > 1024) {
    return {
      ok: false,
      error: agentError(
        'AGENT_VALIDATION_LOG_SIZE_INVALID',
        '日志保留上限必须在 1 到 1024 MB 之间',
        { statusCode: 400, details: { maxSizeMB: requestedSize } }
      )
    };
  }
  const result: MaaLogCleanupResult = await cleanupLogs(maxSizeMB);
  return {
    ok: true,
    result,
    message: `已清理 ${result.deletedCount} 个日志文件，释放 ${(result.freedSpace / 1024 / 1024).toFixed(2)} MB 空间`
  };
}
