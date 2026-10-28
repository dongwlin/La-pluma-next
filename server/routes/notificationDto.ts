/**
 * 通知 HTTP DTO
 *
 * 把 Express 的未知输入收窄成通知适配需要的类型；router 只做 HTTP 适配，
 * 配置持久化仍由 configStorageService 的 `notification` 类型承担，运行时
 * 配置、渠道实例与发送语义仍由 notificationService 持有。
 * - 配置保存体：保持 `req.body || {}`，顶层对象校验、白名单与写盘仍由配置
 *   存储域判定；非对象与数组继续返回既有 400 校验错误，扩展字段原样透传。
 * - 渠道测试/发送：`channel` 沿用旧实现的真值判定，非字符串真值按文本收窄
 *   （渠道注册表以字符串为键，未知渠道仍走既有失败路径）。
 * - 标题/内容/级别沿用旧默认文案与“真值才覆盖”的语义；非字符串按文本输出，
 *   与旧实现进入模板插值后的结果一致。`data` 只保留普通对象，其余按省略处理。
 * - 响应类型只描述通知入口自己拼装的载荷；渠道配置、凭据与出站端口不进入
 *   测试/发送响应。配置读取仍按既有契约返回完整配置供设置页保存（设置页
 *   需要完整 token 才能原样提交），不在本适配层脱敏。
 */

import { agentError } from '../utils/apiHelper.ts';
import type { ApiRequestLike } from '../utils/apiHelper.ts';
import type { ConfigStorageResult } from '../services/configStorageService.ts';
import type { NotificationConfig, NotificationMessage } from '../services/notificationService.ts';

/** 通知路由处理器的请求端口：body 保持 unknown，由本模块按端点收窄。 */
export interface NotificationRequest extends ApiRequestLike {
  body?: unknown;
}

/** 配置读取响应：设置页按既有契约读取完整渠道配置（含凭据）后原样保存。 */
export type NotificationConfigPayload = NotificationConfig;

/** 渠道测试响应：只回显渠道名，不含渠道配置、凭据或出站端口。 */
export interface NotificationChannelTestPayload {
  channel: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 真值才覆盖默认文案；非字符串按文本输出，与旧实现的模板插值结果一致。 */
function textOrDefault(value: unknown, fallback: string): string {
  if (!value) return fallback;
  return typeof value === 'string' ? value : String(value);
}

/** 消息附加数据只保留普通对象；数组与标量按省略处理，避免运行期遍历非对象。 */
function optionalMessageData(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/**
 * 配置保存请求体：Express 5 未解析或缺失请求体按旧实现的 `|| {}` 归一为空对象；
 * 返回 unknown 是因为顶层形状与配置类型白名单仍由 configStorageService 校验，
 * 这里不能先收窄成对象而改变非对象请求体的既有 400 结果。
 */
export function parseNotificationConfigBody(body: unknown): unknown {
  return body || {};
}

/** 渠道测试请求：渠道必须可用，覆盖配置只接受普通对象或省略。 */
export interface NotificationChannelTestInput {
  channel: string;
  config: Record<string, unknown> | null;
}

export function parseChannelTestBody(body: unknown): NotificationChannelTestInput {
  const source = isRecord(body) ? body : {};
  const channel = source.channel;
  if (!channel) {
    throw agentError('AGENT_VALIDATION_CHANNEL_REQUIRED', '缺少通知渠道', { statusCode: 400 });
  }
  const config = source.config;
  if (config != null && !isRecord(config)) {
    throw agentError('AGENT_VALIDATION_NOTIFICATION_CONFIG_INVALID', '通知渠道配置格式无效', { statusCode: 400 });
  }
  return {
    channel: typeof channel === 'string' ? channel : String(channel),
    config: config ?? null
  };
}

/** 发送请求：`channel` 为空时群发；消息字段沿用既有默认文案与级别。 */
export interface NotificationSendInput {
  channel: string | null;
  message: NotificationMessage;
}

export function parseSendNotificationBody(body: unknown): NotificationSendInput {
  const source = isRecord(body) ? body : {};
  const channel = source.channel;
  return {
    channel: channel ? (typeof channel === 'string' ? channel : String(channel)) : null,
    message: {
      title: textOrDefault(source.title, '测试通知'),
      content: textOrDefault(source.content, '这是一条测试通知'),
      // 旧实现只在 undefined 时使用默认级别；非字符串级别从未产生不同的渠道文案，
      // 这里统一按 info 收窄（级别只决定 emoji，未知级别原本也回落 info）。
      level: typeof source.level === 'string' ? source.level : 'info',
      data: optionalMessageData(source.data)
    }
  };
}

/**
 * 配置保存的两步结果：持久化结果与运行时应用结果分别可见，
 * 不合并成单一布尔，避免把“已落盘但未生效”报告成保存成功。
 */
export type NotificationConfigSaveOutcome =
  | { persisted: false; storage: ConfigStorageResult<null> }
  | { persisted: true; applied: true }
  | { persisted: true; applied: false; error: unknown };

/**
 * 先落盘再应用运行时配置：持久化失败原样返回存储结果（由路由映射既有错误码），
 * 应用失败单独记录原始错误（由统一错误出口处理），只有两步都成功才算保存完成。
 */
export async function persistAndApplyNotificationConfig(options: {
  save: () => Promise<ConfigStorageResult<null>>;
  apply: () => void;
}): Promise<NotificationConfigSaveOutcome> {
  const storage = await options.save();
  if (!storage.success) {
    return { persisted: false, storage };
  }
  try {
    options.apply();
  } catch (error) {
    return { persisted: true, applied: false, error };
  }
  return { persisted: true, applied: true };
}
