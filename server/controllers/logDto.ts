/**
 * 日志 HTTP DTO
 *
 * 日志文件路径是命名通配符：Express 5 把捕获值作为路径段数组返回，日志
 * 控制器以 `/` 连接后交给 maaLogFileService 的路径边界，单次解码语义不变。
 * 清理请求的 `maxSizeMB` 只做 Number 归一；范围校验、错误码与错误详情
 * （保留请求体原值）按既有语义在日志控制器构造，envelope 仍由路由层返回。
 */

import type { ReadRequest } from './readDto.ts';

/** `/logs/files/*filePath`：命名通配符的捕获值是路径段数组。 */
export interface LogFileRequest extends ReadRequest {
  params: { filePath: string[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 日志清理请求：requestedSize 保留请求体原值，用于既有错误详情。 */
export interface LogCleanupInput {
  requestedSize: unknown;
  maxSizeMB: number;
}

export function parseLogCleanupBody(body: unknown): LogCleanupInput {
  const requestedSize = isRecord(body) ? body.maxSizeMB : undefined;
  return { requestedSize, maxSizeMB: Number(requestedSize ?? 10) };
}
