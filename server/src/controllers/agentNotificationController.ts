import { saveUserConfig } from '../services/configStorageService.ts';
import { sendConfigStorageError } from './configStorageError.ts';
import {
  getNotificationConfig,
  setNotificationConfig,
  sendNotification,
  sendToChannel,
  testNotificationChannel
} from '../services/notificationService.ts';
import type {
  NotificationChannelTestResult,
  NotificationConfig,
  NotificationDispatchResult,
  NotificationMessage
} from '../services/notificationService.ts';
import {
  agentError,
  sendSuccess,
  sendError
} from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import {
  parseChannelTestBody,
  parseNotificationConfigBody,
  parseSendNotificationBody,
  persistAndApplyNotificationConfig
} from './notificationDto.ts';
import type {
  NotificationChannelTestPayload,
  NotificationRequest
} from './notificationDto.ts';

export interface AgentNotificationControllerDependencies {
  getNotificationConfig?: () => NotificationConfig;
  setNotificationConfig?: (config: unknown) => void;
  testNotificationChannel?: (
    channelName: string,
    configOverride?: unknown
  ) => Promise<NotificationChannelTestResult>;
  sendNotification?: (message: NotificationMessage) => Promise<NotificationDispatchResult>;
  sendToChannel?: (channelName: string, message: NotificationMessage) => Promise<unknown>;
}

export function createAgentNotificationController(
  notification: AgentNotificationControllerDependencies = {}
) {
  const {
    getNotificationConfig: readNotificationConfig = getNotificationConfig,
    setNotificationConfig: applyNotificationConfig = setNotificationConfig,
    testNotificationChannel: runChannelTest = testNotificationChannel,
    sendNotification: sendToAllChannels = sendNotification,
    sendToChannel: sendToSingleChannel = sendToChannel
  } = notification;

  return {
    async readConfig(req: NotificationRequest, res: ApiResponseWriter): Promise<void> {
      return sendSuccess(res, req, readNotificationConfig());
    },

    async saveConfig(req: NotificationRequest, res: ApiResponseWriter): Promise<void> {
      const config = parseNotificationConfigBody(req.body);
      const outcome = await persistAndApplyNotificationConfig({
        save: () => saveUserConfig('notification', config),
        apply: () => applyNotificationConfig(config)
      });
      if (!outcome.persisted) {
        return sendConfigStorageError(res, req, outcome.storage, 'AGENT_NOTIFICATION_CONFIG_SAVE_FAILED', '通知配置保存失败');
      }
      if (!outcome.applied) {
        // 已落盘但运行时应用失败：保留既有统一错误出口，不报告保存成功。
        throw outcome.error;
      }
      return sendSuccess(res, req, null, '通知配置已保存');
    },

    async testChannel(req: NotificationRequest, res: ApiResponseWriter): Promise<void> {
      const { channel, config } = parseChannelTestBody(req.body);
      const result = await runChannelTest(channel, config);
      if (!result.success) {
        return sendError(res, req, agentError('AGENT_NOTIFICATION_TEST_FAILED', result.message || '测试通知失败', {
          statusCode: 400,
          details: { channel }
        }));
      }
      const payload: NotificationChannelTestPayload = { channel };
      return sendSuccess(res, req, payload, result.message || '测试消息已发送');
    },

    async sendMessage(req: NotificationRequest, res: ApiResponseWriter): Promise<void> {
      const { channel, message } = parseSendNotificationBody(req.body);
      const result = channel ? await sendToSingleChannel(channel, message) : await sendToAllChannels(message);
      return sendSuccess(res, req, result, channel ? '通知已发送到指定渠道' : '通知已发送');
    }
  };
}
