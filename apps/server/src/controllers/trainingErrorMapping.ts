import { LocalResourceError } from '../services/operatorTrainingStore.ts';
import { agentError } from '../utils/apiHelper.ts';

/**
 * 本地 MAA 资源是用户可修复的部署依赖：缺失或损坏时返回可行动的 503，
 * 而不是统一 500；其它异常原样交回统一错误出口。
 */
export function mapLocalResourceError(error: unknown): unknown {
  if (!(error instanceof LocalResourceError)) return error;
  const missing = error.code === 'LOCAL_RESOURCE_MISSING';
  const message = missing
    ? `本地 MAA 游戏资源缺失（${error.resourcePath}），请先获取游戏资源后重试，或检查 MAA 资源目录`
    : `本地 MAA 游戏资源不可用（${error.message}），请检查 MAA 资源目录后重试，必要时重新获取游戏资源`;
  const details: Record<string, unknown> = { resourcePath: error.resourcePath };
  if (error.field !== undefined) details.field = error.field;
  return agentError(error.code, message, { statusCode: 503, details, retryable: missing });
}
