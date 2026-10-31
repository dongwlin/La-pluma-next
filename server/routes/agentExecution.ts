import { Router } from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type {
  ExecutionCopilotSetRequest,
  ExecutionRequest,
  ExecutionResponseWriter,
  ExecutionScheduleRequest
} from '../controllers/executionDto.ts';
import * as agentExecutionController from '../controllers/agentExecutionController.ts';

/**
 * 执行路由：只做端点映射，保持与抽离前一致的注册顺序。
 *
 * tracked 执行引擎、Run 生命周期衔接、目标停止与 202/幂等响应在
 * controllers/agentExecutionController.ts；请求体、查询与会话输入在
 * controllers/executionDto.ts 按端点收窄。agent.ts 只按原注册顺序挂载；
 * URL、响应与幂等语义不变。
 */
const router = Router();

// 执行路由：注册顺序与抽离前一致，URL、响应与幂等语义不变。
router.post('/activity/run', asyncHandler<ExecutionRequest, ExecutionResponseWriter>(agentExecutionController.runCurrentActivity));
router.post('/copilot-sets/:id/execute', asyncHandler<ExecutionCopilotSetRequest, ExecutionResponseWriter>(agentExecutionController.executeCopilotSet));
router.post('/actions/continue-copilot-set', asyncHandler<ExecutionRequest, ExecutionResponseWriter>(agentExecutionController.continueCopilotSetAction));
router.post('/schedules/:scheduleId/execute', asyncHandler<ExecutionScheduleRequest, ExecutionResponseWriter>(agentExecutionController.executeSchedule));
router.post('/actions/start-game', asyncHandler<ExecutionRequest, ExecutionResponseWriter>(agentExecutionController.startGame));
router.post('/actions/run-daily-flow', asyncHandler<ExecutionRequest, ExecutionResponseWriter>(agentExecutionController.runDailyFlow));
router.post('/actions/fight', asyncHandler<ExecutionRequest, ExecutionResponseWriter>(agentExecutionController.runFight));
router.post('/actions/run-task', asyncHandler<ExecutionRequest, ExecutionResponseWriter>(agentExecutionController.runTask));
router.post('/actions/stop', asyncHandler<ExecutionRequest, ExecutionResponseWriter>(agentExecutionController.stopExecution));

export default router;
