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

/**
 * 通知控制器：频道配置读写、渠道测试与发送。
 *
 * 这里只做 HTTP 适配。配置持久化仍由 configStorageService 的
 * `notification` 类型承担，运行时配置、渠道实例与发送语义仍由
 * notificationService 持有，出站请求继续经 outboundRequestService
 * 端口；控制器不缓存配置、不直接发起网络请求。
 *
 * 请求体在 notificationDto 按端点从 unknown 收窄（配置体、渠道名称与
 * 覆盖配置、发送消息各按既有规则）；响应载荷复用 notificationService
 * 的公开 DTO，测试/发送响应不携带渠道配置、凭据或出站端口。
 *
 * 通知配置的读取、应用、测试与发送函数可由工厂注入，缺省绑定
 * notificationService 的单例；测试用注入发送器证明 HTTP 回归不会
 * 触达真实通知渠道。配置持久化与运行时应用是两个结果：持久化成功但
 * 运行时应用失败时，请求经统一错误出口返回失败，不能把“已落盘但未生效”
 * 报告成保存成功。路由层（agentNotificationRoutes.ts）只做端点映射；
 * req/res 解析、校验与成功/失败 envelope 都由本控制器的各 handler 装配。
 */

/** 通知控制器的可注入入口：与路由依赖同一形状，缺省绑定 notificationService 单例。 */
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

/**
 * 创建通知控制器：注入点与缺省绑定在此收拢，路由工厂委托本工厂装配，
 * 缺省调用时绑定的仍是 notificationService 的单例导出。
 */
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
