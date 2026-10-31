import { Router } from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type { ApiRequestLike, ApiResponseWriter } from '../utils/apiHelper.ts';
import type { UserConfigStorage } from '../services/configStorageService.ts';
import * as userConfigController from '../controllers/userConfigController.ts';

/**
 * 用户配置路由：配置读取、保存、列表与删除的端点映射。
 *
 * req/res 解析、空配置保存语义与成功/失败 envelope 装配在
 * controllers/userConfigController.ts；存储注入点与缺省绑定
 * configStorageService 默认存储的工厂形态保留在本文件，路由工厂
 * 委托控制器工厂装配。URL、错误码与成功字段与抽离前 agent.ts 的
 * 内联路由保持一致。
 */

/**
 * 配置路由依赖的最小请求结构：路径参数 `configType` 由路由声明收窄为
 * string，JSON 请求体保持 unknown，交给存储域的真实载荷校验收窄。
 */
interface UserConfigRequest extends ApiRequestLike {
  params: { configType: string };
  body?: unknown;
}

/**
 * 用户配置 HTTP 适配 router 工厂。存储实例经参数注入，缺省绑定
 * configStorageService 的默认存储；URL、错误码与成功字段与抽离前
 * agent.ts 的内联路由保持一致。
 */
export function createUserConfigRouter({
  storage
}: {
  storage?: UserConfigStorage;
} = {}) {
  const controller = userConfigController.createUserConfigController({ storage });

  const router = Router();

  router.get('/:configType', asyncHandler<UserConfigRequest, ApiResponseWriter>(controller.load));

  router.post('/:configType', asyncHandler<UserConfigRequest, ApiResponseWriter>(controller.save));

  router.get('/', asyncHandler<UserConfigRequest, ApiResponseWriter>(controller.list));

  router.delete('/:configType', asyncHandler<UserConfigRequest, ApiResponseWriter>(controller.delete));

  return router;
}
