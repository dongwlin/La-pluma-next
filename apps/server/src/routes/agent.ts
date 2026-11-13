import express from 'express';
import agentExecutionRoutes from './agentExecution.ts';
import agentStatusRoutes from './agentStatusRoutes.ts';
import agentDiagnosticsRoutes from './agentDiagnosticsRoutes.ts';
import agentLogRoutes from './agentLogRoutes.ts';
import agentDataRoutes from './agentDataRoutes.ts';
import agentTrainingRoutes from './agentTrainingRoutes.ts';
import agentPreviewRoutes from './agentPreviewRoutes.ts';
import agentNotificationRoutes from './agentNotificationRoutes.ts';
import agentMaintenanceRoutes from './agentMaintenanceRoutes.ts';
import { createAgentInfrastScheduleRouter } from './agentInfrastScheduleRoutes.ts';
import { sendSuccess } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import { DEFAULT_ADB_ADDRESS, DEFAULT_ADB_PATH, DEFAULT_CLIENT_TYPE } from '../config/connectionDefaults.ts';
import { buildAgentManifest, buildOpenApiSpec } from './agentContract.ts';
import type { ReadRequest } from '../controllers/readDto.ts';
import type { InfrastScheduleService } from '../services/infrastScheduleService.ts';

export interface AgentRouterOptions {
  infrastScheduleService?: InfrastScheduleService;
}

export function createAgentRouter(options: AgentRouterOptions = {}): express.Router {
  const router = express.Router();

  router.get('/manifest', (req: ReadRequest, res: ApiResponseWriter) => {
    return sendSuccess(res, req, buildAgentManifest({
      adbPath: DEFAULT_ADB_PATH,
      adbAddress: DEFAULT_ADB_ADDRESS,
      clientType: DEFAULT_CLIENT_TYPE
    }));
  });

  router.get('/openapi.json', (_req: ReadRequest, res: ApiResponseWriter) => {
    res.json(buildOpenApiSpec({
      adbPath: DEFAULT_ADB_PATH,
      adbAddress: DEFAULT_ADB_ADDRESS,
      clientType: DEFAULT_CLIENT_TYPE
    }));
  });

  router.use(agentStatusRoutes);

  router.use(agentDiagnosticsRoutes);

  router.use(agentPreviewRoutes);

  router.use(agentLogRoutes);

  router.use(agentExecutionRoutes);

  router.use(agentDataRoutes);

  router.use(agentTrainingRoutes);

  router.use(createAgentInfrastScheduleRouter(options.infrastScheduleService));

  router.use(agentNotificationRoutes);

  router.use(agentMaintenanceRoutes);

  return router;
}

export default createAgentRouter();
