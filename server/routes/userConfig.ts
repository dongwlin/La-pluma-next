import { Router } from 'express';
import {
  deleteUserConfig,
  getAllUserConfigs,
  loadUserConfig,
  saveUserConfig
} from '../services/configStorageService.ts';
import type { ConfigStorageResult, UserConfigStorage } from '../services/configStorageService.ts';
import { asyncHandler, agentError, sendSuccess, sendError } from '../utils/apiHelper.ts';
import type { ApiRequestLike, ApiResponseWriter, MaybeApiRequest } from '../utils/apiHelper.ts';

/**
 * 配置路由依赖的最小请求结构：路径参数 `configType` 由路由声明收窄为
 * string，JSON 请求体保持 unknown，交给存储域的真实载荷校验收窄。
 */
interface UserConfigRequest extends ApiRequestLike {
  params: { configType: string };
  body?: unknown;
}

// 缺省存储适配：绑定 configStorageService 默认实例的既有导出，
// 保留 setConfigStorageDirForTests 对默认目录的测试重定向行为。
const defaultUserConfigStorage: UserConfigStorage = {
  loadUserConfig,
  saveUserConfig,
  getAllUserConfigs,
  deleteUserConfig
};

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

/**
 * 用户配置 HTTP 适配 router 工厂。存储实例经参数注入，缺省绑定
 * configStorageService 的默认存储；URL、错误码与成功字段与抽离前
 * agent.js 的内联路由保持一致。
 */
export function createUserConfigRouter({
  storage = defaultUserConfigStorage
}: {
  storage?: UserConfigStorage;
} = {}) {
  const router = Router();

  router.get('/:configType', asyncHandler<UserConfigRequest, ApiResponseWriter>(async (req, res) => {
    const result = await storage.loadUserConfig(req.params.configType);
    if (!result.success) {
      return sendConfigStorageError(res, req, result, 'AGENT_CONFIG_LOAD_FAILED', '读取配置失败');
    }
    return sendSuccess(res, req, result.data, result.message || '操作成功');
  }));

  router.post('/:configType', asyncHandler<UserConfigRequest, ApiResponseWriter>(async (req, res) => {
    // Express 5 未解析的请求体是 undefined；缺失 body 与 Express 4 的空对象一样
    // 视为合法的空配置保存。
    const body: unknown = req.body;
    const result = await storage.saveUserConfig(req.params.configType, body || {});
    if (!result.success) {
      return sendConfigStorageError(res, req, result, 'AGENT_CONFIG_SAVE_FAILED', '保存配置失败');
    }
    return sendSuccess(res, req, null, result.message || '配置保存成功');
  }));

  router.get('/', asyncHandler<UserConfigRequest, ApiResponseWriter>(async (req, res) => {
    const result = await storage.getAllUserConfigs();
    if (!result.success) {
      return sendConfigStorageError(res, req, result, 'AGENT_CONFIG_LIST_FAILED', '获取配置列表失败');
    }
    return sendSuccess(res, req, result.data || {}, result.message || '操作成功');
  }));

  router.delete('/:configType', asyncHandler<UserConfigRequest, ApiResponseWriter>(async (req, res) => {
    const result = await storage.deleteUserConfig(req.params.configType);
    if (!result.success) {
      return sendConfigStorageError(res, req, result, 'AGENT_CONFIG_DELETE_FAILED', '删除配置失败');
    }
    return sendSuccess(res, req, null, result.message || '配置删除成功');
  }));

  return router;
}
