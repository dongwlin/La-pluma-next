import {
  deleteUserConfig,
  getAllUserConfigs,
  loadUserConfig,
  saveUserConfig
} from '../services/configStorageService.ts';
import type { UserConfigStorage } from '../services/configStorageService.ts';
import { sendSuccess } from '../utils/apiHelper.ts';
import type { ApiRequestLike, ApiResponseWriter } from '../utils/apiHelper.ts';
import { sendConfigStorageError } from './configStorageError.ts';

/**
 * 配置路由依赖的最小请求结构：路径参数 `configType` 由路由声明收窄为
 * string，JSON 请求体保持 unknown，交给存储域的真实载荷校验收窄。
 * 由路由层（routes/userConfig.ts）直接引用。
 */
export interface UserConfigRequest extends ApiRequestLike {
  params: { configType: string };
  body?: unknown;
}

/** 用户配置控制器的可注入端口：与路由工厂依赖同一形状，缺省绑定默认存储。 */
export interface UserConfigControllerDependencies {
  storage?: UserConfigStorage;
}

// 缺省存储适配：绑定 configStorageService 默认实例的既有导出，
// 保留 setConfigStorageDirForTests 对默认目录的测试重定向行为。
const defaultUserConfigStorage: UserConfigStorage = {
  loadUserConfig,
  saveUserConfig,
  getAllUserConfigs,
  deleteUserConfig
};

export function createUserConfigController({
  storage = defaultUserConfigStorage
}: UserConfigControllerDependencies = {}) {
  return {
    async load(req: UserConfigRequest, res: ApiResponseWriter): Promise<void> {
      const result = await storage.loadUserConfig(req.params.configType);
      if (!result.success) {
        return sendConfigStorageError(res, req, result, 'AGENT_CONFIG_LOAD_FAILED', '读取配置失败');
      }
      return sendSuccess(res, req, result.data, result.message || '操作成功');
    },

    async save(req: UserConfigRequest, res: ApiResponseWriter): Promise<void> {
      // Express 5 未解析的请求体是 undefined；缺失 body 与 Express 4 的空对象一样
      // 视为合法的空配置保存。
      const body: unknown = req.body;
      const result = await storage.saveUserConfig(req.params.configType, body || {});
      if (!result.success) {
        return sendConfigStorageError(res, req, result, 'AGENT_CONFIG_SAVE_FAILED', '保存配置失败');
      }
      return sendSuccess(res, req, null, result.message || '配置保存成功');
    },

    async list(req: UserConfigRequest, res: ApiResponseWriter): Promise<void> {
      const result = await storage.getAllUserConfigs();
      if (!result.success) {
        return sendConfigStorageError(res, req, result, 'AGENT_CONFIG_LIST_FAILED', '获取配置列表失败');
      }
      return sendSuccess(res, req, result.data || {}, result.message || '操作成功');
    },

    async delete(req: UserConfigRequest, res: ApiResponseWriter): Promise<void> {
      const result = await storage.deleteUserConfig(req.params.configType);
      if (!result.success) {
        return sendConfigStorageError(res, req, result, 'AGENT_CONFIG_DELETE_FAILED', '删除配置失败');
      }
      return sendSuccess(res, req, null, result.message || '配置删除成功');
    }
  };
}
