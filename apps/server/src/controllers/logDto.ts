import type { ReadRequest } from './readDto.ts';

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
