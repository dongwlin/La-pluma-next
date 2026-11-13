import { Router } from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import {
  createInfrastScheduleController
} from '../controllers/agentInfrastScheduleController.ts';
import type { InfrastScheduleRequest } from '../controllers/agentInfrastScheduleController.ts';
import defaultInfrastScheduleService from '../services/infrastScheduleService.ts';
import type { InfrastScheduleService } from '../services/infrastScheduleService.ts';

export function createAgentInfrastScheduleRouter(
  service: InfrastScheduleService = defaultInfrastScheduleService
) {
  const controller = createInfrastScheduleController(service);

  const router = Router();

  router.get(
    '/infrast-schedules',
    asyncHandler<InfrastScheduleRequest, ApiResponseWriter>(controller.list)
  );

  router.get(
    '/infrast-schedules/document',
    asyncHandler<InfrastScheduleRequest, ApiResponseWriter>(controller.read)
  );

  router.put(
    '/infrast-schedules/document',
    asyncHandler<InfrastScheduleRequest, ApiResponseWriter>(controller.save)
  );

  return router;
}

export default createAgentInfrastScheduleRouter();
