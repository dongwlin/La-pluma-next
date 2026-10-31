import { Router } from 'express';
import operatorTrainingService from '../services/operatorTrainingService.ts';
import { asyncHandler, sendSuccess, sendDryRun } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import { isRecord } from '../services/operatorTrainingModel.ts';
import {
  parseApplyPlanBody,
  parseCandidateFilters,
  parsePlanModeBody,
  parseQueueAddBody,
  parseQueueOrderBody,
  parseSettingsBody
} from './trainingDto.ts';
import type {
  TrainingOperatorListPayload,
  TrainingQueueRemoveRequest,
  TrainingRequest
} from './trainingDto.ts';
import { resolveRequestConnection } from '../controllers/requestConnection.ts';

/**
 * 养成路由：候选干员、队列、设置、计划生成与应用。
 *
 * 路由只做 query/body 收窄和响应适配；队列 revision、计划有效性校验
 * （含旧 `queueRevision` 冲突）、候选/计数投影与变更串行化仍由
 * operatorTrainingService 承担，这里不复制这些判定，也不读取队列或
 * 计算材料。
 *
 * 请求的未知值在 trainingDto 按端点分别收窄；响应沿用领域 DTO
 * （TrainingQueueSnapshot、QueueMutationResult、ApplyPlanResult 等），
 * 不另行拼装字段。
 *
 * 队列写入与流程/定时同步是不同结果：服务在队列已保存但流程或定时同步
 * 失败时仍返回 `queueUpdated` 与 `flowSync`/`scheduleSync` 诊断字段，接口
 * 继续按成功响应返回，不能把部分成功改写成整体失败。
 * `/actions/fetch-training-materials` 只执行数据拉取脚本，不占设备执行租约。
 */
const router = Router();

router.get('/training/operators', asyncHandler<TrainingRequest, ApiResponseWriter>(async (req, res) => {
  const operators = await operatorTrainingService.getOperatorList(parseCandidateFilters(req.query));
  const payload: TrainingOperatorListPayload = { operators, count: operators.length };
  return sendSuccess(res, req, payload);
}));

router.get('/training/queue', asyncHandler<TrainingRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await operatorTrainingService.getTrainingQueue());
}));

router.post('/training/queue', asyncHandler<TrainingRequest, ApiResponseWriter>(async (req, res) => {
  const { operatorId, options } = parseQueueAddBody(req.body);
  const queueItem = await operatorTrainingService.addToQueue(operatorId, options);
  return sendSuccess(res, req, queueItem, '已添加到养成队列');
}));

router.delete('/training/queue/:operatorId', asyncHandler<TrainingQueueRemoveRequest, ApiResponseWriter>(async (req, res) => {
  const result = await operatorTrainingService.removeFromQueue(req.params.operatorId);
  return sendSuccess(res, req, result, '已从养成队列中移除');
}));

router.put('/training/queue/order', asyncHandler<TrainingRequest, ApiResponseWriter>(async (req, res) => {
  const result = await operatorTrainingService.updateQueueOrder(parseQueueOrderBody(req.body));
  return sendSuccess(res, req, result, '队列顺序已更新');
}));

router.post('/training/sync', asyncHandler<TrainingRequest, ApiResponseWriter>(async (req, res) => {
  const result = await operatorTrainingService.syncTrainingFlow();
  return sendSuccess(res, req, result, result.flowSync.status === 'failed' ? '任务流程同步失败，可重试' : '任务流程同步状态已更新');
}));

router.put('/training/settings', asyncHandler<TrainingRequest, ApiResponseWriter>(async (req, res) => {
  const settings = await operatorTrainingService.updateSettings(parseSettingsBody(req.body));
  return sendSuccess(res, req, settings, '设置已更新');
}));

router.post('/training/plan', asyncHandler<TrainingRequest, ApiResponseWriter>(async (req, res) => {
  // 模式先校验：非法请求不解析连接；关卡开放按连接 profile 的客户端游戏日判定。
  const mode = parsePlanModeBody(req.body);
  const { clientType } = await resolveRequestConnection(req, { allowOverrides: true });
  const plan = await operatorTrainingService.generateTrainingPlan(mode, { clientType });
  return sendSuccess(res, req, plan);
}));

router.post('/actions/apply-training-plan', asyncHandler<TrainingRequest, ApiResponseWriter>(async (req, res) => {
  const { plan, settings } = parseApplyPlanBody(req.body);
  const result = await operatorTrainingService.applyPlanToTasks(plan, settings);
  return sendSuccess(res, req, result, '养成计划已应用到任务流程');
}));

router.post('/actions/fetch-training-materials', asyncHandler<TrainingRequest, ApiResponseWriter>(async (req, res) => {
  const plan = { action: 'fetch-training-materials', sideEffects: ['refresh_training_material_cache'] };
  // 旧实现的 `req.body?.dryRun` 对非对象请求体同样不触发 dryRun。
  if (isRecord(req.body) && req.body.dryRun) {
    return sendDryRun(res, req, plan);
  }
  const result = await operatorTrainingService.fetchOperatorMaterials();
  return sendSuccess(res, req, result, '养成材料数据已更新');
}));

export default router;
