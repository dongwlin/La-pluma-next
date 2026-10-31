import { Router } from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import type { UserConfigControllerDependencies, UserConfigRequest } from '../controllers/userConfigController.ts';
import * as userConfigController from '../controllers/userConfigController.ts';

/**
 * 用户配置路由：配置读取、保存、列表与删除的端点映射。
 *
 * req/res 解析、空配置保存语义与成功/失败 envelope 装配在
 * controllers/userConfigController.ts；请求结构与存储注入点
 * （UserConfigRequest / UserConfigControllerDependencies）由该控制器导出，
 * 本文件直接引用，路由工厂委托控制器工厂装配。URL、错误码与成功字段
 * 与抽离前 agent.ts 的内联路由保持一致。
 */

/**
 * 用户配置 HTTP 适配 router 工厂。存储实例经参数注入，缺省绑定
 * configStorageService 的默认存储；URL、错误码与成功字段与抽离前
 * agent.ts 的内联路由保持一致。
 */
export function createUserConfigRouter(deps: UserConfigControllerDependencies = {}) {
  const controller = userConfigController.createUserConfigController(deps);

  const router = Router();

  router.get('/:configType', asyncHandler<UserConfigRequest, ApiResponseWriter>(controller.load));

  router.post('/:configType', asyncHandler<UserConfigRequest, ApiResponseWriter>(controller.save));

  router.get('/', asyncHandler<UserConfigRequest, ApiResponseWriter>(controller.list));

  router.delete('/:configType', asyncHandler<UserConfigRequest, ApiResponseWriter>(controller.delete));

  return router;
}
