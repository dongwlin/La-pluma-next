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

/**
 * 维护与平台入口路由：只做端点映射。
 *
 * 连接/profile 配置、连接诊断、资源与 MAA 更新、定时与自动更新配置、
 * 识别动作，以及更新日志/作业/活动查询的 req/res 解析、校验与 envelope
 * 装配在 controllers/agentMaintenanceController.ts；请求与上游的未知值
 * 收窄在 controllers/maintenanceDto.ts。维护写入与实际执行是不同操作：
 * 带 `dryRun` 的维护动作只返回计划，不发起真实更新。
 */
const router = Router();

router.get('/config/maa/:profileName', asyncHandler<MaintenanceProfileRequest, ApiResponseWriter>(agentMaintenanceController.readProfile));

router.post('/config/maa/:profileName', asyncHandler<MaintenanceProfileRequest, ApiResponseWriter>(agentMaintenanceController.saveProfile));

router.get('/activity', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readActivity));

router.get('/activity/preflight', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readActivityPreflight));

router.get('/activity/copilot-candidates', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readActivityCopilotCandidates));

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

router.get('/paradox/operators', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readParadoxOperators));

router.get('/schedules/status', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readScheduleStatus));

router.get('/schedules/execution', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readScheduleExecutionStatus));

router.post('/schedules', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.registerSchedule));

router.delete('/schedules/:scheduleId', asyncHandler<MaintenanceScheduleStopRequest, ApiResponseWriter>(agentMaintenanceController.stopScheduleById));

router.post('/actions/configure-auto-update', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.configureAutoUpdate));

router.get('/auto-update/status', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readAutoUpdateStatus));

router.post('/actions/open-config-directory', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.openConfigDirectory));

router.post('/actions/update-core', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.updateCore));

router.post('/actions/update-cli', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.updateCli));

router.post('/actions/hot-update-resources', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.hotUpdateResources));

router.post('/actions/test-connection', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.testConnection));

router.get('/actions/discover-devices', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.discoverDevices));

router.get('/version', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readVersion));

router.get('/config-directory', asyncHandler<MaintenanceRequest, ApiResponseWriter>(agentMaintenanceController.readConfigDirectory));

export default router;
