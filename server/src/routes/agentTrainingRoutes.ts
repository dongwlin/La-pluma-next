import { Router } from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import type { TrainingQueueRemoveRequest, TrainingRequest } from '../controllers/trainingDto.ts';
import * as agentTrainingController from '../controllers/agentTrainingController.ts';

/**
 * 养成路由：只做端点映射，保持与抽离前一致的注册顺序。
 *
 * query/body 收窄、候选/计数投影、流程同步消息推导、材料拉取的 dryRun
 * 分支与成功/失败 envelope 装配在 controllers/agentTrainingController.ts，
 * 请求的未知值在 controllers/trainingDto.ts 按端点收窄；队列 revision、
 * 计划有效性校验（含旧 `queueRevision` 冲突）、候选/计数投影与变更串行化
 * 仍由 operatorTrainingService 承担，这里不复制这些判定。队列写入与流程/
 * 定时同步的部分成功语义见控制器说明。
 */
const router = Router();

router.get('/training/operators', asyncHandler<TrainingRequest, ApiResponseWriter>(agentTrainingController.listCandidates));

router.get('/training/queue', asyncHandler<TrainingRequest, ApiResponseWriter>(agentTrainingController.readQueue));

router.post('/training/queue', asyncHandler<TrainingRequest, ApiResponseWriter>(agentTrainingController.addQueueItem));

router.delete('/training/queue/:operatorId', asyncHandler<TrainingQueueRemoveRequest, ApiResponseWriter>(agentTrainingController.removeQueueItem));

router.put('/training/queue/order', asyncHandler<TrainingRequest, ApiResponseWriter>(agentTrainingController.updateQueueOrder));

router.post('/training/sync', asyncHandler<TrainingRequest, ApiResponseWriter>(agentTrainingController.syncFlow));

router.put('/training/settings', asyncHandler<TrainingRequest, ApiResponseWriter>(agentTrainingController.updateSettings));

router.post('/training/plan', asyncHandler<TrainingRequest, ApiResponseWriter>(agentTrainingController.generatePlan));

router.post('/actions/apply-training-plan', asyncHandler<TrainingRequest, ApiResponseWriter>(agentTrainingController.applyPlan));

router.post('/actions/fetch-training-materials', asyncHandler<TrainingRequest, ApiResponseWriter>(agentTrainingController.fetchMaterials));

export default router;
