/**
 * 配置存储错误的共享 HTTP 适配。
 *
 * 用户配置与通知配置等写入路由共用同一错误映射：400 校验错误按原 code
 * 透传，其余按调用方给定的存储失败 code 处理。本模块只依赖 apiHelper 与
 * configStorageService 的结果类型，不归属单一配置领域。
 */

import { agentError, sendError } from '../utils/apiHelper.ts';
import type { ApiResponseWriter, MaybeApiRequest } from '../utils/apiHelper.ts';
import type { ConfigStorageResult } from '../services/configStorageService.ts';

// 配置存储的 400 校验错误按原 code 透传；其余按存储失败处理
const CONFIG_VALIDATION_CODES: ReadonlySet<string> = new Set([
  'AGENT_CONFIG_TYPE_INVALID',
  'AGENT_CONFIG_DATA_INVALID'
]);

/**
 * 配置存储结果的 HTTP 错误出口：400 校验错误保留原 code，
 * 其余按对应路由的存储失败 code 处理。通知配置等其余配置写入
 * 路由复用同一映射，保持错误码与状态一致。
 */
export function sendConfigStorageError(
  res: ApiResponseWriter,
  req: MaybeApiRequest,
  result: ConfigStorageResult<unknown> | null | undefined,
  fallbackCode: string,
  fallbackMessage: string
): void {
  const failure = result?.success === false ? result : null;
  const errorCode = failure?.error?.code;
  const isValidationError = errorCode !== undefined && CONFIG_VALIDATION_CODES.has(errorCode);
  return sendError(res, req, agentError(
    isValidationError ? errorCode : fallbackCode,
    result?.message || fallbackMessage,
    {
      statusCode: isValidationError ? 400 : 500,
      details: failure?.error?.details || {},
      retryable: !isValidationError
    }
  ));
}
