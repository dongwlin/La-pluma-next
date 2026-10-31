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
 * 用户配置控制器：配置的读取、保存、列表与删除。
 *
 * 这里只做 HTTP 适配。配置读写语义（类型白名单、整份保存、统一错误
 * 信封）仍由 configStorageService 持有；存储实例经工厂注入，缺省绑定
 * configStorageService 的默认存储，保留 setConfigStorageDirForTests
 * 对默认目录的测试重定向行为。URL、错误码与成功字段与抽离前
 * agent.ts 的内联路由保持一致。
 *
 * 请求体保持 unknown，交给存储域的真实载荷校验收窄；req/res 解析、
 * 空配置保存语义与成功/失败 envelope 都由本控制器的各 handler 装配，
 * 路由层（routes/userConfig.ts）只做端点映射与工厂导出。
 */

/**
 * 配置路由依赖的最小请求结构：路径参数 `configType` 由路由声明收窄为
 * string，JSON 请求体保持 unknown，交给存储域的真实载荷校验收窄。
 * 与路由层保留的 UserConfigRequest 保持同一形状。
 */
interface UserConfigRequest extends ApiRequestLike {
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

/**
 * 创建用户配置控制器：注入点与缺省绑定在此收拢，路由工厂委托本工厂装配，
 * 缺省调用时绑定的仍是 configStorageService 的默认存储。
 */
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
