import { Router } from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import type {
  MaintenanceCopilotRequest,
  MaintenanceProfileRequest,
  MaintenanceRequest,
  MaintenanceScheduleStopRequest
} from '../controllers/maintenanceDto.ts';
import * as agentMaintenanceController from '../controllers/agentMaintenanceController.ts';

const router = Router();

router.get('/config/maa/:profileName', asyncHandler<MaintenanceProfileRequest, ApiResponseWriter>(agentMaintenanceController.readProfile));

router.post('/config/maa/:profileName', asyncHandler<MaintenanceProfileRequest, ApiResponseWriter>(agentMaintenanceController.saveProfile));

router.get('/activity', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readActivity));

router.post('/actions/depot-recognition', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.runDepotRecognition));

router.post('/actions/operbox-recognition', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.runOperboxRecognition));

router.get('/changelog/core', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readCoreChangelog));

router.get('/changelog/cli', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readCliChangelog));

router.get('/copilots/:id', asyncHandler<MaintenanceCopilotRequest, ApiResponseWriter>(agentMaintenanceController.readCopilot));

router.get('/copilot-sets/:id', asyncHandler<MaintenanceCopilotRequest, ApiResponseWriter>(agentMaintenanceController.readCopilotSet));

router.get('/copilot-sets/:id/plan', asyncHandler<MaintenanceCopilotRequest, ApiResponseWriter>(agentMaintenanceController.readCopilotSetPlan));

router.post('/copilot-sets/:id/reset-progress', asyncHandler<MaintenanceCopilotRequest, ApiResponseWriter>(agentMaintenanceController.resetCopilotSetProgress));

router.get('/paradox/search', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.searchParadox));

router.get('/copilot/search', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.searchCopilot));

router.get('/copilot/stages', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readCopilotStages));

router.get('/paradox/operators', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readParadoxOperators));

router.get('/schedules/status', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readScheduleStatus));

router.get('/schedules/execution', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readScheduleExecutionStatus));

router.post('/schedules', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.registerSchedule));

router.delete('/schedules/:scheduleId', asyncHandler<MaintenanceScheduleStopRequest, ApiResponseWriter>(agentMaintenanceController.stopScheduleById));

router.post('/actions/configure-auto-update', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.configureAutoUpdate));

router.get('/auto-update/status', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readAutoUpdateStatus));

router.post('/actions/open-config-directory', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.openConfigDirectory));

router.post('/actions/update-core', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.updateCore));

router.get('/update-channels', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readChannels));

router.get('/config/resource-source', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readResourceSource));

router.post('/config/resource-source', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.saveResourceSource));

router.post('/actions/update-channel', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.saveChannel));

router.post('/actions/update-cli', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.updateCli));

router.post('/actions/hot-update-resources', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.hotUpdateResources));

router.post('/actions/test-connection', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.testConnection));

router.get('/actions/discover-devices', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.discoverDevices));

router.get('/version', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readVersion));

router.get('/config-directory', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readConfigDirectory));

export default router;
