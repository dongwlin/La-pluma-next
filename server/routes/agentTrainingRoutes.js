import express from 'express';
import operatorTrainingService from '../services/operatorTrainingService.js';
import {
  asyncHandler,
  agentError,
  sendSuccess,
  sendDryRun,
  sendError
} from '../utils/apiHelper.ts';

/**
 * 养成路由：候选干员、队列、设置、计划生成与应用。
 *
 * 路由只做 query/body 归一化和响应适配；队列 revision、计划有效性校验
 * （含旧 `queueRevision` 冲突）、候选/计数投影与变更串行化仍由
 * operatorTrainingService 承担，这里不复制这些判定。
 *
 * 队列写入与流程/定时同步是不同结果：服务在队列已保存但流程或定时同步
 * 失败时仍返回 `queueUpdated` 与 `flowSync`/`scheduleSync` 诊断字段，接口
 * 继续按成功响应返回，不能把部分成功改写成整体失败。
 * `/actions/fetch-training-materials` 只执行数据拉取脚本，不占设备执行租约。
 */
const router = express.Router();

router.get('/training/operators', asyncHandler(async (req, res) => {
  const filters = {
    rarity: req.query.rarity ? parseInt(req.query.rarity) : undefined,
    profession: req.query.profession,
    owned: req.query.owned === 'true' ? true : req.query.owned === 'false' ? false : undefined,
    needsElite2: req.query.needsElite2 === 'true',
    status: req.query.status || 'trainable'
  };
  const operators = await operatorTrainingService.getOperatorList(filters);
  return sendSuccess(res, req, { operators, count: operators.length });
}));

router.get('/training/queue', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, await operatorTrainingService.getTrainingQueue());
}));

router.post('/training/queue', asyncHandler(async (req, res) => {
  const { operatorId, currentElite, targetElite, position } = req.body || {};
  if (!operatorId) {
    return sendError(res, req, agentError('AGENT_VALIDATION_OPERATOR_ID_REQUIRED', '缺少 operatorId 参数', { statusCode: 400 }));
  }
  const queueItem = await operatorTrainingService.addToQueue(operatorId, { currentElite, targetElite, position });
  return sendSuccess(res, req, queueItem, '已添加到养成队列');
}));

router.delete('/training/queue/:operatorId', asyncHandler(async (req, res) => {
  const result = await operatorTrainingService.removeFromQueue(req.params.operatorId);
  return sendSuccess(res, req, result, '已从养成队列中移除');
}));

router.put('/training/queue/order', asyncHandler(async (req, res) => {
  const { operatorIds } = req.body || {};
  if (!Array.isArray(operatorIds)) {
    return sendError(res, req, agentError('AGENT_VALIDATION_OPERATOR_IDS_REQUIRED', 'operatorIds 必须是数组', { statusCode: 400 }));
  }
  const result = await operatorTrainingService.updateQueueOrder(operatorIds);
  return sendSuccess(res, req, result, '队列顺序已更新');
}));

router.post('/training/sync', asyncHandler(async (req, res) => {
  const result = await operatorTrainingService.syncTrainingFlow();
  return sendSuccess(res, req, result, result.flowSync.status === 'failed' ? '任务流程同步失败，可重试' : '任务流程同步状态已更新');
}));

router.put('/training/settings', asyncHandler(async (req, res) => {
  const settings = await operatorTrainingService.updateSettings(req.body || {});
  return sendSuccess(res, req, settings, '设置已更新');
}));

router.post('/training/plan', asyncHandler(async (req, res) => {
  const plan = await operatorTrainingService.generateTrainingPlan(req.body?.mode || 'current');
  return sendSuccess(res, req, plan);
}));

router.post('/actions/apply-training-plan', asyncHandler(async (req, res) => {
  const { plan, settings } = req.body || {};
  if (!plan) {
    return sendError(res, req, agentError('AGENT_VALIDATION_PLAN_REQUIRED', '缺少 plan 参数', { statusCode: 400 }));
  }
  const result = await operatorTrainingService.applyPlanToTasks(plan, settings);
  return sendSuccess(res, req, result, '养成计划已应用到任务流程');
}));

router.post('/actions/fetch-training-materials', asyncHandler(async (req, res) => {
  const plan = { action: 'fetch-training-materials', sideEffects: ['refresh_training_material_cache'] };
  if (req.body?.dryRun) {
    return sendDryRun(res, req, plan);
  }
  const result = await operatorTrainingService.fetchOperatorMaterials();
  return sendSuccess(res, req, result, '养成材料数据已更新');
}));

export default router;
