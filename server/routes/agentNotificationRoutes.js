import express from 'express';
import { saveUserConfig } from '../services/configStorageService.ts';
import { sendConfigStorageError } from './userConfig.ts';
import {
  getNotificationConfig,
  setNotificationConfig,
  sendNotification,
  sendToChannel,
  testNotificationChannel
} from '../services/notificationService.js';
import {
  asyncHandler,
  agentError,
  sendSuccess,
  sendError
} from '../utils/apiHelper.ts';

/**
 * 通知路由：频道配置读写、渠道测试与发送。
 *
 * 这里只做 HTTP 适配。配置持久化仍由 configStorageService 的
 * `notification` 类型承担，运行时配置、渠道实例与发送语义仍由
 * notificationService 持有，出站请求继续经 outboundRequestService
 * 端口；router 不缓存配置、不直接发起网络请求。
 *
 * 通知配置的读取、应用、测试与发送函数可由工厂注入，缺省绑定
 * notificationService 的单例；测试用注入发送器证明 HTTP 回归不会
 * 触达真实通知渠道。配置持久化成功但运行时应用失败时，请求经统一
 * 错误出口返回失败，不能把“已落盘但未生效”报告成保存成功。
 */
export function createAgentNotificationRoutes(notification = {}) {
  const {
    getNotificationConfig: readNotificationConfig = getNotificationConfig,
    setNotificationConfig: applyNotificationConfig = setNotificationConfig,
    testNotificationChannel: runChannelTest = testNotificationChannel,
    sendNotification: sendToAllChannels = sendNotification,
    sendToChannel: sendToSingleChannel = sendToChannel
  } = notification;

  const router = express.Router();

  router.get('/notifications/config', asyncHandler(async (req, res) => {
    return sendSuccess(res, req, readNotificationConfig());
  }));

  router.post('/notifications/config', asyncHandler(async (req, res) => {
    const result = await saveUserConfig('notification', req.body || {});
    if (!result.success) {
      return sendConfigStorageError(res, req, result, 'AGENT_NOTIFICATION_CONFIG_SAVE_FAILED', '通知配置保存失败');
    }
    applyNotificationConfig(req.body || {});
    return sendSuccess(res, req, null, '通知配置已保存');
  }));

  router.post('/actions/test-notification-channel', asyncHandler(async (req, res) => {
    const channel = req.body?.channel;
    const config = req.body?.config;
    if (!channel) {
      return sendError(res, req, agentError('AGENT_VALIDATION_CHANNEL_REQUIRED', '缺少通知渠道', { statusCode: 400 }));
    }
    if (config != null && (typeof config !== 'object' || Array.isArray(config))) {
      return sendError(res, req, agentError('AGENT_VALIDATION_NOTIFICATION_CONFIG_INVALID', '通知渠道配置格式无效', { statusCode: 400 }));
    }
    const result = await runChannelTest(channel, config || null);
    if (!result.success) {
      return sendError(res, req, agentError('AGENT_NOTIFICATION_TEST_FAILED', result.message || '测试通知失败', { statusCode: 400, details: { channel } }));
    }
    return sendSuccess(res, req, { channel }, result.message || '测试消息已发送');
  }));

  router.post('/actions/send-notification', asyncHandler(async (req, res) => {
    const { channel, title, content, level = 'info', data } = req.body || {};
    const payload = { title: title || '测试通知', content: content || '这是一条测试通知', level, data };
    const result = channel ? await sendToSingleChannel(channel, payload) : await sendToAllChannels(payload);
    return sendSuccess(res, req, result, channel ? '通知已发送到指定渠道' : '通知已发送');
  }));

  return router;
}

export default createAgentNotificationRoutes();
