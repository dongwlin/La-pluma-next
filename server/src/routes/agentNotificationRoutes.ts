import { Router } from 'express';
import {
  asyncHandler
} from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import type { AgentNotificationControllerDependencies } from '../controllers/agentNotificationController.ts';
import type { NotificationRequest } from '../controllers/notificationDto.ts';
import * as agentNotificationController from '../controllers/agentNotificationController.ts';

/**
 * 配置持久化与运行时应用是两个结果：持久化成功但运行时应用失败时请求返回失败，
 * 不能把“已落盘但未生效”报告成保存成功。
 */
export type AgentNotificationRouteDependencies = AgentNotificationControllerDependencies;

export function createAgentNotificationRoutes(
  notification: AgentNotificationRouteDependencies = {}
) {
  const controller = agentNotificationController.createAgentNotificationController(notification);

  const router = Router();

  router.get('/notifications/config', asyncHandler<NotificationRequest, ApiResponseWriter>(controller.readConfig));

  router.post('/notifications/config', asyncHandler<NotificationRequest, ApiResponseWriter>(controller.saveConfig));

  router.post('/actions/test-notification-channel', asyncHandler<NotificationRequest, ApiResponseWriter>(controller.testChannel));

  router.post('/actions/send-notification', asyncHandler<NotificationRequest, ApiResponseWriter>(controller.sendMessage));

  return router;
}

export default createAgentNotificationRoutes();
