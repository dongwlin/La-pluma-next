import { Router } from 'express';
import {
  asyncHandler
} from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import type {
  NotificationChannelTestResult,
  NotificationConfig,
  NotificationDispatchResult,
  NotificationMessage
} from '../services/notificationService.ts';
import type { NotificationRequest } from '../controllers/notificationDto.ts';
import * as agentNotificationController from '../controllers/agentNotificationController.ts';

/**
 * 通知路由：频道配置读写、渠道测试与发送的端点映射。
 *
 * req/res 解析、请求体校验与成功/失败 envelope 装配在
 * controllers/agentNotificationController.ts；注入点与缺省绑定
 * notificationService 的工厂形态保留在本文件，路由工厂委托控制器工厂
 * 装配。配置持久化仍由 configStorageService 的 `notification` 类型
 * 承担，运行时配置、渠道实例与发送语义仍由 notificationService 持有。
 * 配置持久化与运行时应用是两个结果：持久化成功但运行时应用失败时，
 * 请求经统一错误出口返回失败，不能把“已落盘但未生效”报告成保存成功。
 */
export interface AgentNotificationRouteDependencies {
  getNotificationConfig?: () => NotificationConfig;
  setNotificationConfig?: (config: unknown) => void;
  testNotificationChannel?: (
    channelName: string,
    configOverride?: unknown
  ) => Promise<NotificationChannelTestResult>;
  sendNotification?: (message: NotificationMessage) => Promise<NotificationDispatchResult>;
  sendToChannel?: (channelName: string, message: NotificationMessage) => Promise<unknown>;
}

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
