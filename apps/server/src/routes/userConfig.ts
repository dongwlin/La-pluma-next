import { Router } from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import type { UserConfigControllerDependencies, UserConfigRequest } from '../controllers/userConfigController.ts';
import * as userConfigController from '../controllers/userConfigController.ts';

export function createUserConfigRouter(deps: UserConfigControllerDependencies = {}) {
  const controller = userConfigController.createUserConfigController(deps);

  const router = Router();

  router.get('/:configType', asyncHandler<UserConfigRequest, ApiResponseWriter>(controller.load));

  router.post('/:configType', asyncHandler<UserConfigRequest, ApiResponseWriter>(controller.save));

  router.get('/', asyncHandler<UserConfigRequest, ApiResponseWriter>(controller.list));

  router.delete('/:configType', asyncHandler<UserConfigRequest, ApiResponseWriter>(controller.delete));

  return router;
}
