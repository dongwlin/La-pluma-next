import { Router } from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type {
  ExecutionCopilotSetRequest,
  ExecutionRequest,
  ExecutionResponseWriter,
  ExecutionScheduleRequest
} from '../controllers/executionDto.ts';
import * as agentExecutionController from '../controllers/agentExecutionController.ts';

const router = Router();

router.post('/copilot-sets/:id/execute', asyncHandler<ExecutionCopilotSetRequest, ExecutionResponseWriter>(agentExecutionController.executeCopilotSet));
router.post('/actions/continue-copilot-set', asyncHandler<ExecutionRequest, ExecutionResponseWriter>(agentExecutionController.continueCopilotSetAction));
router.post('/schedules/:scheduleId/execute', asyncHandler<ExecutionScheduleRequest, ExecutionResponseWriter>(agentExecutionController.executeSchedule));
router.post('/actions/start-game', asyncHandler<ExecutionRequest, ExecutionResponseWriter>(agentExecutionController.startGame));
router.post('/actions/run-daily-flow', asyncHandler<ExecutionRequest, ExecutionResponseWriter>(agentExecutionController.runDailyFlow));
router.post('/actions/fight', asyncHandler<ExecutionRequest, ExecutionResponseWriter>(agentExecutionController.runFight));
router.post('/actions/run-task', asyncHandler<ExecutionRequest, ExecutionResponseWriter>(agentExecutionController.runTask));
router.post('/actions/stop', asyncHandler<ExecutionRequest, ExecutionResponseWriter>(agentExecutionController.stopExecution));

export default router;
