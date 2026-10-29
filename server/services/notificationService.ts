/**
 * 通知服务 - 支持多种通知渠道
 * 当前支持：Telegram
 * 未来可扩展：微信、钉钉、邮件、Bark 等
 *
 * 类型边界：
 * - 持久配置与渠道覆盖配置从 `unknown` 解析：顶层与渠道扩展字段原样保留，
 *   `enabled` 归一化为布尔值，缺失或非法渠道按未启用处理；
 * - 出站响应经 `parseTelegramApiResponse` 收窄，发送结果只保留 ok/description/result
 *   与上游附加字段；渠道凭据（botToken）只存在于运行时配置，不进入发送结果 DTO 或日志；
 * - 发送器（出站客户端）由 `createNotificationService` 注入，测试不需要改写全局 fetch。
 *
 * 游戏日：所有“今日”判断按客户端服务区时区与每日 04:00 日界计算
 * （`gameCalendar`），不读宿主进程时区；关卡周表仍由本模块拥有。
 */

import { createOutboundHttpClient } from './outboundRequestService.ts';
import type { OutboundHttpClient } from './outboundRequestService.ts';
import { createLogger } from '../utils/logger.ts';
import { DEFAULT_CLIENT_TYPE } from '../config/connectionDefaults.ts';
import { getGameDay, resolveGameZone } from './gameCalendar.ts';

// 创建日志记录器
const logger = createLogger('Notification');

const TELEGRAM_LEVEL_EMOJIS: Record<string, string> = {
  info: 'ℹ️',
  success: '✅',
  warning: '⚠️',
  error: '❌'
};

/** 通知消息：标题与内容必填，级别未建模时按 info 输出，图片只交给支持图片的渠道。 */
export interface NotificationMessage {
  title: string;
  content: string;
  /** 兼容任意级别字符串；未匹配的级别回落到 info。 */
  level?: string;
  /** 附加到消息尾部的键值详情；值按文本输出。 */
  data?: Record<string, unknown> | null;
  /** base64 图片；缺省或空串表示只发送文本。 */
  image?: string | null;
}

/** 单个渠道的持久配置：扩展字段（如 botToken/chatId）原样保留，不在类型层区分渠道。 */
export interface NotificationChannelConfig {
  enabled: boolean;
  [extension: string]: unknown;
}

/** 通知配置文档：顶层扩展字段随配置读写往返保存，不因解析被丢弃。 */
export interface NotificationConfig {
  enabled: boolean;
  channels: Record<string, NotificationChannelConfig>;
  [extension: string]: unknown;
}

/** 渠道测试的公开结果：不携带渠道配置或凭据。 */
export interface NotificationChannelTestResult {
  success: boolean;
  message: string;
}

export interface NotificationChannelOutcome {
  channel: string;
  success: true;
}

export interface NotificationChannelFailure {
  channel: string;
  error: string;
}

/** 群发结果：通知未启用时只返回 success/message，保持既有响应形状。 */
export interface NotificationDispatchResult {
  success: boolean;
  message: string;
  results?: NotificationChannelOutcome[];
  errors?: NotificationChannelFailure[];
}

/** Telegram Bot API 响应：ok/description/result 显式建模，其余上游字段原样保留。 */
export interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  result?: Record<string, unknown>;
  [extension: string]: unknown;
}

export interface DailyOpenStage {
  stage: string;
  name: string;
  isOpen: boolean;
}

export interface DailyStageOverview {
  /** 判定所用的游戏日（客户端服务区时区 + 04:00 日界）。 */
  gameDate: string;
  /** 判定所用的客户端类型；未知值规范化为 Official。 */
  clientType: string;
  /** 游戏日星期：0=周日, 1=周一, ..., 6=周六。 */
  weekday: number;
  open: DailyOpenStage[];
  closed: DailyOpenStage[];
}

/** 游戏日查询：时刻与客户端类型可注入，缺省取当前时刻与连接默认客户端。 */
export interface StageDayQuery {
  now?: Date;
  clientType?: string;
}

export interface StageOpenState {
  isOpen: boolean;
  reason: string | null;
  stageName?: string;
}

/** 结构化执行结果条目：只要求格式化实际读取的字段，其余由产生方自行维护。 */
export interface NotificationTaskAction {
  task?: string;
  status?: string;
  message?: string;
}

export interface NotificationTaskReport {
  provider?: string;
  status?: string;
  message?: string;
}

export interface NotificationRecruitSummary {
  tags?: string;
  stars?: string | number;
}

export interface NotificationTaskSummary {
  task?: string;
  stage?: string;
  times?: string;
  duration?: string;
  medicine?: string;
  stone?: string;
  drops?: string;
  recruits?: NotificationRecruitSummary[];
  infrast?: string;
}

export interface NotificationTaskError {
  task?: string;
  error?: string;
}

export interface NotificationTaskSkip {
  task?: string;
  reason?: string;
}

/** 任务完成通知入参：全部字段可选，缺省值保持原有文案。 */
export interface TaskCompletionInfo {
  taskName?: string;
  totalTasks?: number;
  successTasks?: number;
  failedTasks?: number;
  skippedTasks?: number;
  duration?: number;
  errors?: Array<NotificationTaskError | string>;
  skipped?: Array<NotificationTaskSkip | string>;
  summaries?: NotificationTaskSummary[];
  actions?: NotificationTaskAction[];
  reports?: NotificationTaskReport[];
  warnings?: string[];
  screenshot?: string | null;
}

/** 格式化后的完成通知：级别与详情已归一化，可直接交给渠道发送。 */
export interface TaskCompletionMessage extends NotificationMessage {
  title: string;
  content: string;
  level: 'info' | 'success' | 'warning' | 'error';
  data: Record<string, string | number>;
  image?: string | null;
}

/** 解析边界：只接受普通对象，数组与 null 不是配置文档。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 读取结构化结果的可选文本字段：非对象条目按缺失处理，
 * 保持原先可选访问对 null/undefined 条目的容忍，不因类型收窄引入新的运行期异常。
 */
function readTextField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return field ? String(field) : null;
}

/**
 * 渠道配置解析：保留全部扩展字段，缺失或非布尔的 enabled 归一化为 false。
 * 非对象渠道值按未启用处理，避免运行期对字符串/数字做属性访问。
 */
function parseNotificationChannelConfig(value: unknown): NotificationChannelConfig {
  if (!isRecord(value)) return { enabled: false };
  return { ...value, enabled: Boolean(value.enabled) };
}

function parseNotificationChannels(value: unknown): Record<string, NotificationChannelConfig> {
  if (!isRecord(value)) return {};
  const channels: Record<string, NotificationChannelConfig> = {};
  for (const [name, channel] of Object.entries(value)) {
    channels[name] = parseNotificationChannelConfig(channel);
  }
  return channels;
}

/** 配置文档解析：扩展字段往返保留，enabled 与 channels 收窄为可安全读取的形状。 */
function parseNotificationConfig(value: unknown): NotificationConfig {
  const record = isRecord(value) ? value : {};
  return {
    ...record,
    enabled: Boolean(record.enabled),
    channels: parseNotificationChannels(record.channels)
  };
}

/** 运行时配置更新沿用浅合并语义：传入 channels 时整体替换，未传字段保持现值。 */
function applyNotificationConfigPatch(current: NotificationConfig, patch: unknown): NotificationConfig {
  if (!isRecord(patch)) return current;
  return parseNotificationConfig({ ...current, ...patch });
}

/** Telegram 出站响应解析：非法载荷按 ok=false 处理，由发送方给出既有失败文案。 */
function parseTelegramApiResponse(value: unknown): TelegramApiResponse {
  const record = isRecord(value) ? value : {};
  const response: TelegramApiResponse = { ...record, ok: record.ok === true };
  if (typeof record.description === 'string') response.description = record.description;
  if (isRecord(record.result)) response.result = record.result;
  return response;
}

export function formatTelegramMessage(
  title: string,
  content: string,
  level: string = 'info',
  data?: Record<string, unknown> | null,
  now: Date = new Date()
): string {
  const emoji = TELEGRAM_LEVEL_EMOJIS[level] || TELEGRAM_LEVEL_EMOJIS.info;
  let text = `${emoji} *${title}*\n\n${content}`;

  if (data) {
    text += '\n\n📊 *详细信息*';
    Object.entries(data).forEach(([key, value]) => {
      text += `\n• ${key}: ${String(value)}`;
    });
  }

  return `${text}\n\n🕐 ${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
}

interface ResourceStageSchedule {
  name: string;
  days: number[];
  hidden?: boolean;
}

// 资源本开放日表。days 是游戏日星期：0=周日, 1=周一, ..., 6=周六。
const RESOURCE_STAGES: Record<string, ResourceStageSchedule> = {
  'CE-6': { name: '龙门币', days: [0, 2, 4, 6] }, // 周日、周二、周四、周六
  'AP-5': { name: '采购凭证', days: [0, 1, 4, 6] }, // 周日、周一、周四、周六
  'CA-5': { name: '技巧概要', days: [0, 2, 3, 5] }, // 周日、周二、周三、周五
  'LS-6': { name: '作战记录', days: [0, 1, 2, 3, 4, 5, 6] }, // 每天

  'PR-A': { name: '重装/医疗芯片', days: [0, 1, 4, 5] }, // 周日、周一、周四、周五
  'PR-A-1': { name: '重装/医疗芯片', days: [0, 1, 4, 5], hidden: true },
  'PR-A-2': { name: '重装/医疗芯片组', days: [0, 1, 4, 5], hidden: true },
  'PR-B': { name: '狙击/术师芯片', days: [1, 2, 5, 6] }, // 周一、周二、周五、周六
  'PR-B-1': { name: '狙击/术师芯片', days: [1, 2, 5, 6], hidden: true },
  'PR-B-2': { name: '狙击/术师芯片组', days: [1, 2, 5, 6], hidden: true },
  'PR-C': { name: '先锋/辅助芯片', days: [0, 3, 4, 6] }, // 周日、周三、周四、周六
  'PR-C-1': { name: '先锋/辅助芯片', days: [0, 3, 4, 6], hidden: true },
  'PR-C-2': { name: '先锋/辅助芯片组', days: [0, 3, 4, 6], hidden: true },
  'PR-D': { name: '近卫/特种芯片', days: [0, 2, 3, 6] }, // 周日、周二、周三、周六
  'PR-D-1': { name: '近卫/特种芯片', days: [0, 2, 3, 6], hidden: true },
  'PR-D-2': { name: '近卫/特种芯片组', days: [0, 2, 3, 6], hidden: true },

  'SK-5': { name: '碳', days: [1, 3, 5, 6] },     // 周一、周三、周五、周六
};

export function getTodayOpenStages(query: StageDayQuery = {}): DailyStageOverview {
  const now = query.now ?? new Date();
  const clientType = query.clientType ?? DEFAULT_CLIENT_TYPE;
  const gameDay = getGameDay(now, clientType);
  const open: DailyOpenStage[] = [];
  const closed: DailyOpenStage[] = [];

  Object.entries(RESOURCE_STAGES).forEach(([stage, info]) => {
    if (info.hidden) return;

    const item: DailyOpenStage = {
      stage,
      name: info.name,
      isOpen: info.days.includes(gameDay.weekday)
    };

    if (item.isOpen) {
      open.push(item);
    } else {
      closed.push(item);
    }
  });

  return {
    gameDate: gameDay.date,
    clientType: resolveGameZone(clientType).clientType,
    weekday: gameDay.weekday,
    open,
    closed
  };
}

/**
 * 检查关卡是否在游戏日开放。
 * “今日”指客户端服务区的游戏日（时区 + 04:00 日界），不是宿主日历日。
 */
export function isStageOpenToday(stage: string, query: StageDayQuery = {}): StageOpenState {
  const stageKey = stage.toUpperCase();
  if (!RESOURCE_STAGES[stageKey]) {
    return { isOpen: true, reason: null }; // 非资源本，默认开放
  }

  const now = query.now ?? new Date();
  const clientType = query.clientType ?? DEFAULT_CLIENT_TYPE;
  const today = getGameDay(now, clientType).weekday; // 0=周日, 1=周一, ..., 6=周六
  const stageInfo = RESOURCE_STAGES[stageKey];
  const isOpen = stageInfo.days.includes(today);

  return {
    isOpen,
    reason: isOpen ? null : `${stageInfo.name}今日未开放`,
    stageName: stageInfo.name
  };
}

const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  enabled: false,
  channels: {
    telegram: {
      enabled: false,
      botToken: '',
      chatId: '',
    },
    // 预留其他通知渠道
    wechat: {
      enabled: false,
      // 微信企业号配置
    },
    dingtalk: {
      enabled: false,
      // 钉钉机器人配置
    },
    email: {
      enabled: false,
      // 邮件配置
    },
    bark: {
      enabled: false,
      // Bark 配置
    }
  }
};

/**
 * 通知接口 - 所有通知渠道都需要实现这个接口
 */
class NotificationChannel {
  config: NotificationChannelConfig;

  constructor(config: NotificationChannelConfig) {
    this.config = config;
  }

  /**
   * 发送通知；返回渠道相关的公开结果，不包含渠道配置或凭据。
   */
  async send(_message: NotificationMessage): Promise<unknown> {
    throw new Error('子类必须实现 send 方法');
  }

  /**
   * 测试连接
   */
  async test(): Promise<NotificationChannelTestResult> {
    throw new Error('子类必须实现 test 方法');
  }

  canSendImage(): boolean {
    return false;
  }
}

/**
 * Telegram 通知渠道
 */
class TelegramChannel extends NotificationChannel {
  botToken: string;
  chatId: string;
  outboundHttp: OutboundHttpClient;

  constructor(config: NotificationChannelConfig, outboundHttp: OutboundHttpClient) {
    super(config);
    this.outboundHttp = outboundHttp;
    // 凭据在构造时收窄为字符串：后续 URL 拼接与日志都不会接触原始配置对象。
    this.botToken = typeof config.botToken === 'string' ? config.botToken : '';
    this.chatId = typeof config.chatId === 'string' ? config.chatId : '';
  }

  canSendImage(): boolean {
    return Boolean(this.botToken && this.chatId);
  }

  async send(message: NotificationMessage): Promise<TelegramApiResponse> {
    if (!this.botToken || !this.chatId) {
      throw new Error('Telegram 配置不完整');
    }

    const { title, content, level = 'info', data, image } = message;

    // 如果有图片，使用 sendPhoto API
    if (image) {
      return await this.sendPhoto(title, content, level, data, image);
    }

    const text = formatTelegramMessage(title, content, level, data);

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;

    const { data: payload } = await this.outboundHttp.requestJson(url, {
      method: 'POST',
      body: {
        chat_id: this.chatId,
        text: text,
        parse_mode: 'Markdown',
      },
    });

    const result = parseTelegramApiResponse(payload);
    if (!result.ok) {
      throw new Error(`Telegram 发送失败: ${result.description || '未知错误'}`);
    }

    return result;
  }

  async sendPhoto(
    title: string,
    content: string,
    level: string,
    data: Record<string, unknown> | null | undefined,
    imageBase64: string
  ): Promise<TelegramApiResponse> {
    const caption = formatTelegramMessage(title, content, level, data);

    const url = `https://api.telegram.org/bot${this.botToken}/sendPhoto`;

    // 将 base64 转换为 Buffer
    const imageBuffer = Buffer.from(imageBase64, 'base64');

    // 检查图片大小（Telegram 限制 10MB）
    const imageSizeMB = imageBuffer.length / 1024 / 1024;
    logger.debug('图片大小检查', { sizeMB: imageSizeMB.toFixed(2) });

    if (imageSizeMB > 10) {
      logger.warn('图片超过 10MB，尝试不发送图片', { sizeMB: imageSizeMB.toFixed(2) });
      // 图片太大，改为发送纯文本消息
      return await this.send({ title, content, level, data });
    }

    // 使用原生 FormData/Blob 构造 multipart：出站端口绑定原生 fetch，
    // 编码与 boundary 由运行时完成；字段与文件名保持原有线上契约。
    const formData = new FormData();
    formData.append('chat_id', this.chatId);
    formData.append('photo', new Blob([imageBuffer], { type: 'image/png' }), 'screenshot.png');
    formData.append('caption', caption);
    formData.append('parse_mode', 'Markdown');

    // 添加重试机制
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.debug('发送 Telegram 图片', { attempt, maxRetries });

        const { data: payload } = await this.outboundHttp.requestMultipart(url, {
          formData,
          timeoutMs: 30000, // 30秒超时
        });

        const result = parseTelegramApiResponse(payload);
        if (!result.ok) {
          throw new Error(`Telegram 发送图片失败: ${result.description || '未知错误'}`);
        }

        logger.success('Telegram 图片发送成功');
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(errorMessageOf(error));
        logger.error('发送 Telegram 图片失败', {
          attempt,
          maxRetries,
          error: errorMessageOf(error)
        });

        if (attempt < maxRetries) {
          // 等待后重试
          const waitTime = attempt * 2000; // 2秒、4秒
          logger.debug('等待后重试', { waitMs: waitTime });
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    // 所有重试都失败，尝试发送不带图片的消息
    logger.warn('发送图片失败，改为发送纯文本消息');
    try {
      return await this.send({ title, content, level, data });
    } catch {
      throw new Error(`发送图片和文本消息都失败: ${lastError ? lastError.message : '未知错误'}`);
    }
  }

  async test(): Promise<NotificationChannelTestResult> {
    try {
      await this.send({
        title: '测试通知',
        content: 'La Pluma Next 通知系统测试成功！',
        level: 'info',
      });
      return { success: true, message: '测试消息已发送' };
    } catch (error) {
      return { success: false, message: errorMessageOf(error) };
    }
  }
}

/** 通知配置更新入口：保留渠道注册表，配置文档替换为解析后的新值。 */
export interface NotificationService {
  setConfig(config: unknown): void;
  getConfig(): NotificationConfig;
  shouldCaptureScreenshot(): boolean;
  sendNotification(message: NotificationMessage): Promise<NotificationDispatchResult>;
  sendToChannel(channelName: string, message: NotificationMessage): Promise<unknown>;
  testChannel(channelName: string, configOverride?: unknown): Promise<NotificationChannelTestResult>;
}

/** 服务依赖：出站发送端口可注入，测试不需要改写全局 fetch。 */
export interface NotificationServiceDependencies {
  /** 出站客户端；缺省绑定全局 fetch 的独立实例。 */
  outboundHttp?: OutboundHttpClient;
  /** 初始持久配置，走与 setConfig 相同的解析边界。 */
  config?: unknown;
}

type NotificationChannelFactory = (
  config: NotificationChannelConfig,
  outboundHttp: OutboundHttpClient
) => NotificationChannel;

/**
 * 通知管理器：持有配置、渠道注册表与出站端口。
 */
class NotificationManager {
  config: NotificationConfig;
  outboundHttp: OutboundHttpClient;
  channels: Map<string, NotificationChannelFactory>;

  constructor(options: { config: NotificationConfig; outboundHttp: OutboundHttpClient }) {
    this.config = options.config;
    this.outboundHttp = options.outboundHttp;
    this.channels = new Map();
    this.initChannels();
  }

  initChannels() {
    // 注册 Telegram 渠道
    this.registerChannel(
      'telegram',
      (config, outboundHttp) => new TelegramChannel(config, outboundHttp)
    );

    // 未来可以在这里注册更多渠道
    // this.registerChannel('wechat', WeChatChannel);
    // this.registerChannel('dingtalk', DingTalkChannel);
    // this.registerChannel('email', EmailChannel);
    // this.registerChannel('bark', BarkChannel);
  }

  registerChannel(name: string, factory: NotificationChannelFactory) {
    this.channels.set(name, factory);
  }

  setConfig(config: unknown) {
    this.config = applyNotificationConfigPatch(this.config, config);
    logger.info('通知配置已更新');
  }

  getConfig(): NotificationConfig {
    // 返回完整配置（不隐藏敏感信息）：设置页需要完整 token 才能正确保存。
    // 通过同一解析边界做深拷贝，返回值与运行时配置不共享引用。
    return parseNotificationConfig(JSON.parse(JSON.stringify(this.config)));
  }

  hasReadyImageChannel(): boolean {
    if (!this.config.enabled) return false;

    for (const [channelName, factory] of this.channels.entries()) {
      const channelConfig = this.config.channels[channelName];
      if (!channelConfig?.enabled) continue;
      if (factory(channelConfig, this.outboundHttp).canSendImage()) return true;
    }
    return false;
  }

  /**
   * 发送通知到所有启用的渠道
   */
  async sendToAll(message: NotificationMessage): Promise<NotificationDispatchResult> {
    if (!this.config.enabled) {
      logger.info('通知功能未启用');
      return { success: true, message: '通知功能未启用' };
    }

    const results: NotificationChannelOutcome[] = [];
    const errors: NotificationChannelFailure[] = [];

    for (const [channelName, factory] of this.channels.entries()) {
      const channelConfig = this.config.channels[channelName];

      if (!channelConfig || !channelConfig.enabled) {
        continue;
      }

      try {
        await factory(channelConfig, this.outboundHttp).send(message);
        results.push({ channel: channelName, success: true });
        logger.success('通知已发送', { channel: channelName });
      } catch (error) {
        const message = errorMessageOf(error);
        errors.push({ channel: channelName, error: message });
        logger.error('发送通知失败', {
          channel: channelName,
          error: message
        });
      }
    }

    return {
      success: errors.length === 0,
      results,
      errors,
      message: errors.length === 0
        ? `通知已发送到 ${results.length} 个渠道`
        : `部分渠道发送失败: ${errors.map(e => e.channel).join(', ')}`
    };
  }

  /**
   * 发送到指定渠道
   */
  async sendToChannel(channelName: string, message: NotificationMessage): Promise<unknown> {
    const factory = this.channels.get(channelName);

    if (!factory) {
      throw new Error(`未知的通知渠道: ${channelName}`);
    }

    const channelConfig = this.config.channels[channelName];

    if (!channelConfig || !channelConfig.enabled) {
      throw new Error(`通知渠道 ${channelName} 未启用`);
    }

    return await factory(channelConfig, this.outboundHttp).send(message);
  }

  /**
   * 测试指定渠道
   */
  async testChannel(
    channelName: string,
    configOverride: unknown = null
  ): Promise<NotificationChannelTestResult> {
    const factory = this.channels.get(channelName);

    if (!factory) {
      throw new Error(`未知的通知渠道: ${channelName}`);
    }

    // 覆盖配置与持久配置走同一解析边界；凭据只用于本次测试，不写回运行时配置。
    const channelConfig = configOverride
      ? parseNotificationChannelConfig(configOverride)
      : this.config.channels[channelName];

    if (!channelConfig) {
      throw new Error(`通知渠道 ${channelName} 未配置`);
    }

    return await factory(channelConfig, this.outboundHttp).test();
  }
}

/**
 * 创建独立通知服务实例：配置、渠道注册表与出站端口均由实例持有。
 * 缺省实例绑定内置配置与全局 fetch；测试注入出站端口即可验证发送契约。
 */
export function createNotificationService(
  dependencies: NotificationServiceDependencies = {}
): NotificationService {
  const manager = new NotificationManager({
    config: applyNotificationConfigPatch(
      parseNotificationConfig(DEFAULT_NOTIFICATION_CONFIG),
      dependencies.config
    ),
    outboundHttp: dependencies.outboundHttp ?? createOutboundHttpClient()
  });

  return {
    setConfig: config => manager.setConfig(config),
    getConfig: () => manager.getConfig(),
    shouldCaptureScreenshot: () => manager.hasReadyImageChannel(),
    sendNotification: message => manager.sendToAll(message),
    sendToChannel: (channelName, message) => manager.sendToChannel(channelName, message),
    testChannel: (channelName, configOverride) => manager.testChannel(channelName, configOverride)
  };
}

// 创建全局通知服务实例
const defaultNotificationService = createNotificationService();

/**
 * 设置通知配置
 */
export function setNotificationConfig(config: unknown) {
  defaultNotificationService.setConfig(config);
}

/**
 * 获取通知配置
 */
export function getNotificationConfig(): NotificationConfig {
  return defaultNotificationService.getConfig();
}

export function shouldCaptureNotificationScreenshot(): boolean {
  return defaultNotificationService.shouldCaptureScreenshot();
}

/**
 * 发送通知
 */
export async function sendNotification(message: NotificationMessage): Promise<NotificationDispatchResult> {
  return await defaultNotificationService.sendNotification(message);
}

/**
 * 发送到指定渠道
 */
export async function sendToChannel(channelName: string, message: NotificationMessage): Promise<unknown> {
  return await defaultNotificationService.sendToChannel(channelName, message);
}

/**
 * 测试通知渠道
 */
export async function testNotificationChannel(
  channelName: string,
  configOverride: unknown = null
): Promise<NotificationChannelTestResult> {
  return await defaultNotificationService.testChannel(channelName, configOverride);
}

/**
 * 发送任务完成通知
 */
export function buildTaskCompletionMessage(taskInfo: TaskCompletionInfo = {}): TaskCompletionMessage {
  const {
    taskName = '自动化任务',
    totalTasks = 0,
    successTasks = 0,
    failedTasks = 0,
    skippedTasks = 0,
    duration = 0,
    errors = [],
    skipped = [],
    summaries = [],
    actions = [],
    reports = [],
    warnings = [],
    screenshot = null
  } = taskInfo;

  const normalizedActions = Array.isArray(actions) ? actions : [];
  const normalizedReports = Array.isArray(reports) ? reports : [];
  const normalizedWarnings = Array.isArray(warnings) ? warnings : [];
  const normalizedSkipped = Array.isArray(skipped) ? skipped : [];
  const normalizedErrors = Array.isArray(errors) ? errors : [];
  const normalizedSummaries = Array.isArray(summaries) ? summaries : [];
  const hasStructuredFailure = normalizedActions.some(action => readTextField(action, 'status') === 'failed')
    || normalizedReports.some(report => readTextField(report, 'status') === 'failed');
  const hasStructuredSkip = normalizedActions.some(action => readTextField(action, 'status') === 'skipped');
  const hasFailure = failedTasks > 0 || hasStructuredFailure;
  const hasSkip = skippedTasks > 0 || hasStructuredSkip;

  // 根据任务结果确定通知级别和标题
  let level: TaskCompletionMessage['level'] = 'success';
  let title = '任务完成';

  if (hasFailure && hasSkip) {
    level = 'warning';
    title = '任务完成（部分失败/跳过）';
  } else if (hasFailure) {
    level = 'warning';
    title = '任务完成（部分失败）';
  } else if (hasSkip) {
    level = 'info';
    title = '任务完成（部分跳过）';
  }

  let content = `*${taskName}* 执行完成`;

  if (normalizedActions.length > 0) {
    const statusIcons: Record<string, string> = { success: '✅', skipped: '⏭️', failed: '❌' };
    content += '\n\n🔎 *执行结果*';
    normalizedActions.forEach(action => {
      const status = readTextField(action, 'status');
      const icon = statusIcons[status ?? ''] || '•';
      const taskLabel = readTextField(action, 'task');
      content += `\n${icon} ${taskLabel ? `${taskLabel}: ` : ''}${readTextField(action, 'message') || '状态未知'}`;
    });
  }

  if (normalizedReports.length > 0) {
    const providerLabels: Record<string, string> = { penguin: '企鹅物流', yituliu: '一图流' };
    content += '\n\n📡 *掉落汇报*';
    normalizedReports.forEach(report => {
      const icon = readTextField(report, 'status') === 'success' ? '✅' : '❌';
      const providerKey = readTextField(report, 'provider');
      const provider = providerLabels[providerKey ?? ''] || providerKey || '未知平台';
      content += `\n${icon} ${provider}: ${readTextField(report, 'message') || '状态未知'}`;
    });
  }

  if (normalizedWarnings.length > 0) {
    content += '\n\n⚠️ *执行提示*';
    normalizedWarnings.forEach(warning => {
      content += `\n• ${String(warning)}`;
    });
  }

  // 添加任务总结信息
  if (normalizedSummaries.length > 0) {
    content += '\n\n📋 *任务总结*';
    normalizedSummaries.forEach(summary => {
      content += `\n\n*${summary.task}*`;

      // 理智作战总结
      if (summary.stage) {
        content += `\n• 关卡: ${summary.stage}`;
        if (summary.times) content += `\n• 次数: ${summary.times}`;
        if (summary.duration) content += `\n• 耗时: ${summary.duration}`;
        if (summary.medicine && summary.medicine !== '0') content += `\n• 理智药: ${summary.medicine}`;
        if (summary.stone && summary.stone !== '0') content += `\n• 源石: ${summary.stone}`;

        // 掉落信息（已经是格式化的字符串）
        if (summary.drops) {
          content += `\n• 掉落: ${summary.drops}`;
        }
      }

      // 公招总结
      if (summary.recruits) {
        content += '\n• 公招结果:';
        summary.recruits.forEach(recruit => {
          content += `\n  - [${recruit.tags}] → ${recruit.stars}⭐`;
        });
      }

      // 基建总结
      if (summary.infrast) {
        content += `\n• ${summary.infrast}`;
      }
    });
  }

  // 跳过的任务（资源本未开放等）
  const representedTasks = new Set<string>();
  normalizedActions.forEach(action => {
    const task = readTextField(action, 'task');
    if (task) representedTasks.add(task);
  });
  const remainingSkipped = normalizedSkipped.filter(item => {
    const task = typeof item === 'string' ? item : readTextField(item, 'task');
    return !task || !representedTasks.has(task);
  });
  if (remainingSkipped.length > 0) {
    content += `\n\n⏭️ *跳过任务*`;
    remainingSkipped.forEach(s => {
      if (typeof s === 'string') content += `\n• ${s}`;
      else {
        const reason = readTextField(s, 'reason');
        content += `\n• ${readTextField(s, 'task')}${reason ? ` - ${reason}` : ''}`;
      }
    });
  }

  // 失败的任务
  const remainingErrors = normalizedErrors.filter(item => {
    const task = typeof item === 'string' ? item : readTextField(item, 'task');
    return !task || !representedTasks.has(task);
  });
  if (remainingErrors.length > 0) {
    content += `\n\n❌ *失败任务*`;
    remainingErrors.forEach(e => {
      // 处理对象格式 { task: '任务名', error: '错误信息' } 或字符串格式
      const task = readTextField(e, 'task');
      if (task) {
        const error = readTextField(e, 'error');
        content += `\n• ${task}${error ? ` - ${error}` : ''}`;
      } else {
        content += `\n• ${String(e)}`;
      }
    });
  }

  const data: Record<string, string | number> = {
    '总任务数': totalTasks,
    '成功': successTasks,
  };
  if (skippedTasks > 0) data['跳过'] = skippedTasks;
  if (failedTasks > 0) data['失败'] = failedTasks;
  const failedReportCount = normalizedReports.filter(
    report => readTextField(report, 'status') === 'failed'
  ).length;
  if (failedReportCount > 0) data['汇报失败'] = failedReportCount;
  data['耗时'] = `${Math.floor(duration / 1000)} 秒`;

  return {
    title,
    content,
    level,
    data,
    image: screenshot
  };
}

export async function sendTaskCompletionNotification(
  taskInfo: TaskCompletionInfo
): Promise<NotificationDispatchResult> {
  return await sendNotification(buildTaskCompletionMessage(taskInfo));
}
