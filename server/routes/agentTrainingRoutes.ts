import { Router } from 'express';
import { asyncHandler, sendDryRun, sendSuccess } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import type { TrainingQueueRemoveRequest, TrainingRequest } from '../controllers/trainingDto.ts';
import * as agentTrainingController from '../controllers/agentTrainingController.ts';

/**
 * 养成路由：只做端点映射与 envelope 装配。
 *
 * query/body 收窄、候选/计数投影、流程同步消息推导与材料拉取的 dryRun
 * 分支在 controllers/agentTrainingController.ts，请求的未知值在
 * controllers/trainingDto.ts 按端点收窄；队列 revision、计划有效性校验
 * （含旧 `queueRevision` 冲突）、候选/计数投影与变更串行化仍由
 * operatorTrainingService 承担，这里不复制这些判定。队列写入与流程/定时
 * 同步的部分成功语义见控制器说明。
 */
const router = Router();

router.get('/training/operators', asyncHandler<TrainingRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await agentTrainingController.listCandidates(req));
}));

router.get('/training/queue', asyncHandler<TrainingRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await agentTrainingController.readQueue());
}));

router.post('/training/queue', asyncHandler<TrainingRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await agentTrainingController.addQueueItem(req.body), '已添加到养成队列');
}));

router.delete('/training/queue/:operatorId', asyncHandler<TrainingQueueRemoveRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await agentTrainingController.removeQueueItem(req.params.operatorId), '已从养成队列中移除');
}));

router.put('/training/queue/order', asyncHandler<TrainingRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await agentTrainingController.updateQueueOrder(req.body), '队列顺序已更新');
}));

router.post('/training/sync', asyncHandler<TrainingRequest, ApiResponseWriter>(async (req, res) => {
  const { payload, message } = await agentTrainingController.syncFlow();
  return sendSuccess(res, req, payload, message);
}));

router.put('/training/settings', asyncHandler<TrainingRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await agentTrainingController.updateSettings(req.body), '设置已更新');
}));

router.post('/training/plan', asyncHandler<TrainingRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await agentTrainingController.generatePlan(req));
}));

router.post('/actions/apply-training-plan', asyncHandler<TrainingRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await agentTrainingController.applyPlan(req.body), '养成计划已应用到任务流程');
}));

router.post('/actions/fetch-training-materials', asyncHandler<TrainingRequest, ApiResponseWriter>(async (req, res) => {
  const outcome = await agentTrainingController.fetchMaterials(req.body);
  if (outcome.dryRun) {
    return sendDryRun(res, req, outcome.plan);
  }
  return sendSuccess(res, req, outcome.result, '养成材料数据已更新');
}));

export default router;
