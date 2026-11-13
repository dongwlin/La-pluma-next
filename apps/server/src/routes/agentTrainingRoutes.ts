import { Router } from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type { ApiResponseWriter, MaybeApiRequest, NextLike } from '../utils/apiHelper.ts';
import type { TrainingQueueRemoveRequest, TrainingRequest } from '../controllers/trainingDto.ts';
import * as agentTrainingController from '../controllers/agentTrainingController.ts';
import { mapLocalResourceError } from '../controllers/trainingErrorMapping.ts';

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

function mapTrainingLocalResourceError(
  error: unknown,
  _req: MaybeApiRequest,
  _res: ApiResponseWriter,
  next: NextLike
): void {
  next(mapLocalResourceError(error));
}

router.use(mapTrainingLocalResourceError);

export default router;
