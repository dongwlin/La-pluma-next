/**
 * Telegram Bot 服务 - 接收命令控制任务
 *
 * 轮询生命周期：
 * - 每个实例同一时刻只有一个有效轮询会话。重复初始化或改配置会先停止旧会话，
 *   再按新配置启动；旧会话停止后不再接受更新、不再派发命令。
 * - 会话持有独立的 AbortController：长轮询请求、轮询间隔、等待重试与命令内的
 *   倒计时都绑定同一个 signal，停止会立即取消在途请求和等待。
 * - 长轮询使用大于 Telegram 停留时长的独立时限（TELEGRAM_LONG_POLL_TIMEOUT_MS），
 *   不使用出站端口的缺省短时限。
 *
 * 出站调用统一经 outboundRequestService：getUpdates 是 POST，端口不自动重放；
 * 轮询失败只重新发起读取，不会重放已经派发的设备命令。offset 在派发更新时推进，
 * 与既有语义一致。
 *
 * 类型边界：
 * - 长轮询载荷与 Bot API 响应从 `unknown` 解析：getUpdates 的 `ok` 必须是字面量 true、
 *   `result` 必须是数组；发送类响应的 `ok`/`description`/`result` 按声明类型收窄，
 *   其余上游字段保留；
 * - 每个 update 先校验再派发：缺少整数 update_id 的条目无法推进 offset，直接忽略；
 *   非文本消息或缺少 chat/from 的条目只推进 offset，不执行命令；
 * - 文本先解析为 TelegramCommandInput（命令名、原始词元与命中来源），再形成带缺省值
 *   的领域输入 TelegramCommandRequest，执行分支只读取领域字段；
 * - 命令错误统一以既有文案回复；设备命令仍复用 execMaaCommand 与停止规则，
 *   未创建 HTTP Run 的 /run 流程入口按现行契约保留（直接调用 executeScheduleNow）。
 */

import { createOutboundHttpClient, isOutboundRequestError } from './outboundRequestService.ts';
import type { OutboundHttpClient } from './outboundRequestService.ts';
import { executeScheduleNow, getScheduleExecutionStatus } from './schedulerService.ts';
import type { ScheduleExecutionStatus } from './scheduleFlowExecution.ts';
import { execMaaCommand } from './maaExecutionService.ts';
import { getTaskStatus, stopCurrentTask } from './maaProcessService.ts';
import { captureScreen } from './maaDeviceService.ts';
import type { CapturedScreen } from './maaDeviceService.ts';
import { resolveConnection } from './connectionService.js';
import { normalizeCopilotUri, parseCopilotUri } from './copilotUri.js';
import { loadUserConfig } from './configStorageService.ts';
import type { ConfigStorageResult } from './configStorageService.ts';
import { createLogger } from '../utils/logger.ts';
import type { RuntimeLifecycle } from './runtimeLifecycleService.ts';
import { DEFAULT_ADB_ADDRESS, DEFAULT_ADB_PATH, DEFAULT_CLIENT_TYPE } from '../config/connectionDefaults.js';

const logger = createLogger('TelegramBot');

/** Telegram getUpdates 的停留秒数。 */
export const TELEGRAM_LONG_POLL_SECONDS = 30;
/** 长轮询请求的唯一时限：必须大于停留秒数，避免正常长轮询被误判为超时。 */
export const TELEGRAM_LONG_POLL_TIMEOUT_MS = 40_000;
const POLL_INTERVAL_MS = 2_000;
const POLL_ERROR_RETRY_MS = 5_000;
const PHOTO_TIMEOUT_MS = 30_000;
const DEFAULT_API_BASE_URL = 'https://api.telegram.org';
const DEFAULT_COPILOT_API_BASE_URL = 'https://prts.maa.plus';

/** Bot 运行配置：已知字段显式声明，通知渠道带来的其余字段原样保留。 */
export interface TelegramBotConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
  /** 授权用户 ID；为空时回落到单 ID 兼容比较。 */
  allowedUserIds: readonly string[];
  [extension: string]: unknown;
}

const DEFAULT_CONFIG: TelegramBotConfig = {
  enabled: false,
  botToken: '',
  chatId: '',
  allowedUserIds: [], // 允许的用户 ID 列表
  adbPath: DEFAULT_ADB_PATH,
  adbAddress: DEFAULT_ADB_ADDRESS,
  allowedCommands: ['start', 'stop', 'status', 'fight', 'roguelike', 'copilot', 'startup', 'closedown', 'screenshot', 'help']
};

/** 轮询会话状态：停止标记与清理句柄只属于创建它的那一代轮询者。 */
interface TelegramBotSession {
  id: number;
  config: TelegramBotConfig;
  controller: AbortController;
  stopped: boolean;
  stopReason: string | null;
  loop: Promise<void> | null;
  cleanups: Set<() => void>;
}

/** 公开状态：与既有 getStatus 字段一致。 */
export interface TelegramBotStatus {
  enabled: boolean;
  polling: boolean;
  generation: number;
  offset: number;
}

export interface TelegramBotStopResult {
  stopped: boolean;
  reason: string;
  generation?: number;
}

export interface TelegramLifecycleAttachment {
  attached: boolean;
  duplicate: boolean;
}

/** 日志端口：保留既有四个级别，测试可注入静默或记录实现。 */
export interface TelegramBotLogger {
  debug(message: string, data?: unknown): unknown;
  info(message: string, data?: unknown): unknown;
  warn(message: string, data?: unknown): unknown;
  error(message: string, data?: unknown): unknown;
}

/** 任务投影：只读取执行状态与停止结果，不复制 MAA 进程状态。 */
export interface TelegramTaskStatus {
  isRunning: boolean;
  taskName?: string | null;
  startTime?: number | null;
}

export interface TelegramStopResult {
  success: boolean;
  message?: string;
}

/** 设备命令端口：参数与 execMaaCommand 的起始参数一致，返回值不参与 Bot 决策。 */
export type TelegramCommandExecutor = (
  command: string,
  args?: readonly string[],
  taskName?: string | null,
  taskType?: string | null,
  waitForCompletion?: boolean
) => Promise<unknown>;

/** 连接解析结果：截图只消费 ADB 路径与地址。 */
export interface TelegramDeviceConnection {
  adbPath?: unknown;
  address?: unknown;
}

/** Telegram Bot API 响应：ok/description/result 显式建模，其余上游字段原样保留。 */
export interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  result?: Record<string, unknown>;
  [extension: string]: unknown;
}

/** 可执行的消息更新：chat/from/text 已收窄，命令派发不需要再做属性访问。 */
export interface TelegramTextMessage {
  chatId: string;
  userId: string;
  isBot: boolean;
  text: string;
}

/** 单个 update：message 为 null 表示不是可执行文本消息，只推进 offset。 */
export interface TelegramMessageUpdate {
  updateId: number;
  message: TelegramTextMessage | null;
}

/** 已识别的命令名；未知命令不在联合内，由 rawName 保留原文。 */
export type TelegramCommandName =
  | 'start'
  | 'help'
  | 'status'
  | 'startup'
  | 'closedown'
  | 'screenshot'
  | 'setcommands'
  | 'fight'
  | 'roguelike'
  | 'copilot'
  | 'schedule'
  | 'stop'
  | 'run'
  | 'flow';

/** 文本命中来源：仅用于保持既有调试日志，不参与执行。 */
export type TelegramCommandSource =
  | 'copilot-uri'
  | 'keyword'
  | 'fight'
  | 'roguelike'
  | 'startup'
  | 'closedown'
  | 'run'
  | 'slash';

/** 命令解析结果：名称已识别时是稳定的命令标识，参数保持消息中的原始词元。 */
export interface TelegramCommandInput {
  name: TelegramCommandName | null;
  /** 未知命令回显用：已去掉 `/` 与参数。 */
  rawName: string;
  args: string[];
  source: TelegramCommandSource;
}

/** 领域输入：缺省值（客户端、主题、流程类型）在解析阶段确定。 */
export type TelegramCommandRequest =
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'startup'; clientType: string }
  | { kind: 'closedown'; clientType: string }
  | { kind: 'screenshot' }
  | { kind: 'setcommands' }
  /** stage 为 null 表示缺少关卡参数，由执行层回复既有提示。 */
  | { kind: 'fight'; stage: string | null }
  | { kind: 'roguelike'; theme: string }
  /** uri 为 null 表示缺少作业参数，由执行层回复既有提示。 */
  | { kind: 'copilot'; uri: string | null }
  | { kind: 'schedule' }
  | { kind: 'stop' }
  | { kind: 'run'; flowType: string }
  | { kind: 'unknown'; rawName: string };

/** 可注入依赖：出站、执行、状态、连接与配置读取全部经端口，测试不触网。 */
export interface TelegramBotDependencies {
  outbound: OutboundHttpClient;
  execMaaCommand: TelegramCommandExecutor;
  getTaskStatus: () => TelegramTaskStatus;
  stopCurrentTask: () => TelegramStopResult;
  captureScreen: (adbPath?: unknown, address?: unknown) => Promise<CapturedScreen>;
  executeScheduleNow: (scheduleId: string, taskFlow: unknown) => Promise<unknown>;
  getScheduleExecutionStatus: () => ScheduleExecutionStatus;
  resolveConnection: () => Promise<TelegramDeviceConnection>;
  loadUserConfig: (configType: string) => Promise<ConfigStorageResult<unknown>>;
  logger: TelegramBotLogger;
  apiBaseUrl: string;
  copilotApiBaseUrl: string;
}

export type TelegramBotServiceOverrides = Partial<TelegramBotDependencies>;

export interface TelegramBotService {
  init(config?: unknown): TelegramBotStatus;
  stop(reason?: string): Promise<TelegramBotStopResult>;
  attachLifecycle(lifecycle?: RuntimeLifecycle | null): TelegramLifecycleAttachment;
  getStatus(): TelegramBotStatus;
}

/** 解析边界：只接受普通对象，数组与 null 不是配置或上游载荷。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 配置补丁解析：已知字段按声明类型收窄，其余字段原样保留，未提供字段保持当前值。
 * 保留重新配置的浅合并语义；非数组 allowedUserIds 按未配置处理。
 */
function applyConfigPatch(current: TelegramBotConfig, patch: unknown): TelegramBotConfig {
  if (!isRecord(patch)) return current;
  const next: TelegramBotConfig = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'enabled') {
      next.enabled = Boolean(value);
    } else if (key === 'botToken') {
      if (typeof value === 'string') next.botToken = value;
    } else if (key === 'chatId') {
      if (typeof value === 'string') next.chatId = value;
    } else if (key === 'allowedUserIds') {
      if (Array.isArray(value)) {
        next.allowedUserIds = value.filter((id): id is string => typeof id === 'string');
      }
    } else {
      next[key] = value;
    }
  }
  return next;
}

/** 上游响应解析：非法载荷按 ok=false 处理，由调用方给出既有失败文案。 */
function parseTelegramApiResponse(value: unknown): TelegramApiResponse {
  if (!isRecord(value)) return { ok: false };
  const response: TelegramApiResponse = { ...value, ok: value.ok === true };
  if (typeof value.description === 'string') response.description = value.description;
  if (isRecord(value.result)) response.result = value.result;
  return response;
}

/** getUpdates 载荷：ok 必须是字面量 true，result 必须是数组。 */
function parseUpdatesPayload(value: unknown): unknown[] {
  if (!isRecord(value) || value.ok !== true) {
    const upstream = isRecord(value) && typeof value.description === 'string' ? value.description : '';
    throw new Error(upstream || 'Failed to get updates');
  }
  return Array.isArray(value.result) ? value.result : [];
}

/** chat/user ID 兼容数字与字符串两种 Telegram 表示，统一比较为字符串。 */
function readTelegramId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * 消息校验：不是文本消息或缺少 chat/from 时返回 null（只确认更新，不派发命令）。
 * 不完整的消息不再在异步处理里抛属性访问错误。
 */
function parseMessageUpdate(value: unknown): TelegramTextMessage | null {
  if (!isRecord(value) || typeof value.text !== 'string') return null;
  const chat = isRecord(value.chat) ? value.chat : null;
  const from = isRecord(value.from) ? value.from : null;
  const chatId = readTelegramId(chat?.id);
  const userId = readTelegramId(from?.id);
  if (chatId === null || userId === null) return null;
  return {
    chatId,
    userId,
    isBot: Boolean(from?.is_bot),
    text: value.text
  };
}

/** 单个 update 校验：update_id 必须是整数，否则无法推进 offset，直接忽略。 */
function parseUpdate(value: unknown): TelegramMessageUpdate | null {
  if (!isRecord(value)) return null;
  const updateId = value.update_id;
  if (typeof updateId !== 'number' || !Number.isInteger(updateId)) return null;
  return { updateId, message: parseMessageUpdate(value.message) };
}

/** 本地收窄 copilotUri 模块（尚未类型化）的返回值，避免 any 扩散。 */
function readCopilotUri(uri: string): { id: string; isSet: boolean } | null {
  const parsed: unknown = parseCopilotUri(uri);
  if (!isRecord(parsed) || typeof parsed.id !== 'string') return null;
  return { id: parsed.id, isSet: Boolean(parsed.isSet) };
}

function normalizeUri(uri: string): string {
  const normalized: unknown = normalizeCopilotUri(uri);
  return typeof normalized === 'string' ? normalized : uri;
}

/** 关键词映射表（只包含不带参数的命令）。 */
const keywordMap: Record<string, TelegramCommandName> = {
  '截图': 'screenshot',
  '截屏': 'screenshot',
  'screenshot': 'screenshot',
  '帮助': 'help',
  '命令': 'help',
  'help': 'help',
  '状态': 'status',
  'status': 'status',
  '停止': 'stop',
  '停止任务': 'stop',
  'stop': 'stop',
  // 不带参数的启动/关闭/肉鸽（使用默认值）
  '启动游戏': 'startup',
  '开启游戏': 'startup',
  '打开游戏': 'startup',
  '关闭游戏': 'closedown',
  '肉鸽': 'roguelike',
  // 不带参数的任务流程（使用默认 automation）
  '运行': 'run',
  '运行流程': 'run',
  '执行流程': 'run',
  '日常': 'run'
};

const FIGHT_KEYWORDS = ['刷', '刷关卡', 'fight'] as const;
const ROGUELIKE_KEYWORDS = ['肉鸽', '刷肉鸽', 'roguelike'] as const;
const STARTUP_KEYWORDS = ['启动', '启动游戏', '开启', '打开', '开启游戏', '打开游戏', 'startup'] as const;
const CLOSEDOWN_KEYWORDS = ['关闭', '关闭游戏', 'closedown'] as const;
const RUN_KEYWORDS = ['运行', '运行流程', '执行流程', 'run', 'flow'] as const;

function matchesFamily(firstWord: string, family: readonly string[], restWords: readonly string[]): boolean {
  return restWords.length > 0 && family.includes(firstWord);
}

/** `/命令` 只识别稳定命令名；未识别时保留原文用于既有未知命令回复。 */
function resolveSlashCommand(name: string): TelegramCommandName | null {
  switch (name) {
    case 'start':
    case 'help':
    case 'status':
    case 'startup':
    case 'closedown':
    case 'screenshot':
    case 'setcommands':
    case 'fight':
    case 'roguelike':
    case 'copilot':
    case 'schedule':
    case 'stop':
    case 'run':
    case 'flow':
      return name;
    default:
      return null;
  }
}

/**
 * 文本解析：关键词、带参数关键词、作业 URI 与 `/命令` 的判定顺序与既有实现一致。
 * 无法识别为命令的文本返回 null（由调用方静默忽略）。
 */
export function parseTelegramCommand(text: string): TelegramCommandInput | null {
  // 检查作业 URI
  if (readCopilotUri(text)) {
    return { name: 'copilot', rawName: 'copilot', args: [text], source: 'copilot-uri' };
  }

  // 检查是否是关键词（不带参数的命令）；只认自有键，避免原型属性被当成命令。
  const keyword = Object.hasOwn(keywordMap, text) ? keywordMap[text] : undefined;
  if (keyword) {
    return { name: keyword, rawName: keyword, args: [], source: 'keyword' };
  }

  // 检查是否是带参数的关键词命令
  const words = text.split(' ');
  const firstWord = words[0];
  const restWords = words.slice(1);

  // 刷关卡：刷 1-7, 刷关卡 1-7, fight 1-7
  if (matchesFamily(firstWord, FIGHT_KEYWORDS, restWords)) {
    return { name: 'fight', rawName: 'fight', args: restWords, source: 'fight' };
  }

  // 肉鸽：肉鸽 Sami, 刷肉鸽 Sami, roguelike Sami
  if (matchesFamily(firstWord, ROGUELIKE_KEYWORDS, restWords)) {
    return { name: 'roguelike', rawName: 'roguelike', args: restWords, source: 'roguelike' };
  }

  // 启动游戏：启动 Official, 启动游戏 Official, 开启 Official, 打开 Official
  if (matchesFamily(firstWord, STARTUP_KEYWORDS, restWords)) {
    return { name: 'startup', rawName: 'startup', args: restWords, source: 'startup' };
  }

  // 关闭游戏：关闭 Official, 关闭游戏 Official
  if (matchesFamily(firstWord, CLOSEDOWN_KEYWORDS, restWords)) {
    return { name: 'closedown', rawName: 'closedown', args: restWords, source: 'closedown' };
  }

  // 运行流程：运行 automation, 运行流程 automation, run automation
  if (matchesFamily(firstWord, RUN_KEYWORDS, restWords)) {
    return { name: 'run', rawName: 'run', args: restWords, source: 'run' };
  }

  // 检查是否是命令（以 / 开头）
  if (!text.startsWith('/')) {
    return null;
  }

  const commandWords = text.split(' ');
  const rawName = commandWords[0].replace('/', '');
  return {
    name: resolveSlashCommand(rawName),
    rawName,
    args: commandWords.slice(1),
    source: 'slash'
  };
}

/** 命令解析结果到领域输入的适配：缺省值与既有执行分支保持一致。 */
export function resolveTelegramCommandRequest(input: TelegramCommandInput): TelegramCommandRequest {
  switch (input.name) {
    case 'start':
    case 'help':
      return { kind: 'help' };
    case 'status':
      return { kind: 'status' };
    case 'startup':
      return { kind: 'startup', clientType: input.args[0] || DEFAULT_CLIENT_TYPE };
    case 'closedown':
      return { kind: 'closedown', clientType: input.args[0] || DEFAULT_CLIENT_TYPE };
    case 'screenshot':
      return { kind: 'screenshot' };
    case 'setcommands':
      return { kind: 'setcommands' };
    case 'fight':
      return { kind: 'fight', stage: input.args.length === 0 ? null : input.args[0] };
    case 'roguelike':
      return { kind: 'roguelike', theme: input.args[0] || 'Sami' };
    case 'copilot':
      return { kind: 'copilot', uri: input.args.length === 0 ? null : input.args[0] };
    case 'schedule':
      return { kind: 'schedule' };
    case 'stop':
      return { kind: 'stop' };
    case 'run':
    case 'flow':
      return { kind: 'run', flowType: input.args[0] || 'automation' };
    case null:
      return { kind: 'unknown', rawName: input.rawName };
  }
  // 类型上已穷尽；运行期兜底避免未识别名称得到 undefined 的领域输入。
  return { kind: 'unknown', rawName: input.rawName };
}

/**
 * 创建 Telegram Bot 服务实例。
 *
 * 依赖全部可注入：出站端口、命令执行、状态读取、定时流程与配置读取都通过
 * overrides 替换，测试使用假依赖时不触碰真实网络、设备或 MAA CLI。
 */
export function createTelegramBotService(overrides: TelegramBotServiceOverrides = {}): TelegramBotService {
  const dependencies: TelegramBotDependencies = {
    outbound: createOutboundHttpClient(),
    execMaaCommand,
    getTaskStatus,
    stopCurrentTask,
    captureScreen,
    executeScheduleNow,
    getScheduleExecutionStatus,
    resolveConnection,
    loadUserConfig,
    logger,
    apiBaseUrl: DEFAULT_API_BASE_URL,
    copilotApiBaseUrl: DEFAULT_COPILOT_API_BASE_URL,
    ...overrides
  };

  let botConfig: TelegramBotConfig = { ...DEFAULT_CONFIG };
  let lastUpdateId = 0;
  let generation = 0;
  let session: TelegramBotSession | null = null;
  const attachedLifecycles = new WeakSet<RuntimeLifecycle>();
  let attachedLifecycle: RuntimeLifecycle | null = null;

  function isActive(target: TelegramBotSession | null): target is TelegramBotSession {
    return target !== null && target === session && !target.stopped;
  }

  function createSession(config: TelegramBotConfig): TelegramBotSession {
    generation += 1;
    return {
      id: generation,
      config,
      controller: new AbortController(),
      stopped: false,
      stopReason: null,
      loop: null,
      cleanups: new Set()
    };
  }

  /** 同步停止：置停止标记、清理会话定时器并中止所有在途请求与等待。幂等。 */
  function stopSession(target: TelegramBotSession | null, reason: string): void {
    if (!target || target.stopped) return;
    target.stopped = true;
    target.stopReason = reason;
    for (const cleanup of [...target.cleanups]) {
      try {
        cleanup();
      } catch {
        // 清理失败不阻断其余收尾
      }
    }
    target.cleanups.clear();
    target.controller.abort(new Error(`Telegram 轮询已停止: ${reason}`));
  }

  /**
   * 可取消等待：会话停止时立即返回 false，调用方据此结束当前工作；
   * 正常到点返回 true。计时器随停止清理，不残留。
   */
  function waitForSession(target: TelegramBotSession | null, ms: number): Promise<boolean> {
    if (!isActive(target)) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        target.controller.signal.removeEventListener('abort', onAbort);
        target.cleanups.delete(cancel);
        resolve(value);
      };
      const onAbort = (): void => finish(false);
      const cancel = (): void => finish(false);
      const timer = setTimeout(() => finish(isActive(target)), ms);
      target.cleanups.add(cancel);
      target.controller.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * 会话级定时器：停止时自动清理；回调异常不会变成未处理的 Promise 拒绝。
   * 返回的 stop 可提前结束定时器，重复调用幂等。
   */
  function startSessionInterval(target: TelegramBotSession, callback: () => unknown, ms: number): () => void {
    let timer: ReturnType<typeof setInterval> | null = null;
    const stopInterval = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      target.cleanups.delete(stopInterval);
    };
    timer = setInterval(() => {
      if (!isActive(target)) {
        stopInterval();
        return;
      }
      Promise.resolve()
        .then(callback)
        .catch(error => {
          if (isActive(target)) {
            dependencies.logger.error('Telegram 后台任务失败', { error: errorMessageOf(error) });
          }
        });
    }, ms);
    target.cleanups.add(stopInterval);
    return stopInterval;
  }

  function getStatus(): TelegramBotStatus {
    return {
      enabled: Boolean(botConfig.enabled && botConfig.botToken && botConfig.chatId),
      polling: Boolean(session),
      generation,
      offset: lastUpdateId
    };
  }

  /**
   * 初始化（或重新配置）Telegram Bot。
   *
   * 同一实例只保留一个有效轮询者：先同步停止旧会话，再按新配置决定是否启动。
   * 停止发生在启动之前，旧会话的在途请求会被中止，旧会话的迟到更新不会执行命令。
   */
  function init(config?: unknown): TelegramBotStatus {
    if (!config) {
      dependencies.logger.debug('配置不完整，跳过初始化');
      return getStatus();
    }

    botConfig = applyConfigPatch(botConfig, config);

    const previous = session;
    if (previous) stopSession(previous, 'reconfigure');
    session = null;

    if (!botConfig.enabled || !botConfig.botToken || !botConfig.chatId) {
      dependencies.logger.debug('配置不完整或未启用，跳过初始化');
      return getStatus();
    }
    if (attachedLifecycle && typeof attachedLifecycle.isDraining === 'function' && attachedLifecycle.isDraining()) {
      dependencies.logger.warn('运行时正在关闭，拒绝启动 Telegram 轮询');
      return getStatus();
    }

    const target = createSession(botConfig);
    session = target;
    target.loop = runPolling(target);
    void setupBotCommands(target).catch(error => {
      if (isActive(target)) {
        dependencies.logger.error('设置命令菜单错误', { error: errorMessageOf(error) });
      }
    });
    dependencies.logger.info('已启动，等待命令');
    return getStatus();
  }

  /**
   * 停止轮询：中止在途长轮询与等待，并等待轮询循环退出。
   * 重复调用返回相同结果；没有活动会话时也按已完成处理。
   */
  async function stop(reason = 'stopped'): Promise<TelegramBotStopResult> {
    const target = session;
    if (!target) return { stopped: false, reason };
    stopSession(target, reason);
    session = null;
    try {
      await target.loop;
    } catch {
      // 轮询循环自行收尾，不向外传播
    }
    return { stopped: true, reason, generation: target.id };
  }

  /**
   * 把停止能力注册到运行时关闭流程；同一 lifecycle 只注册一次。
   * 关闭开始后 init 不再启动新的轮询者。
   */
  function attachLifecycle(lifecycle?: RuntimeLifecycle | null): TelegramLifecycleAttachment {
    if (!lifecycle || typeof lifecycle.register !== 'function') {
      return { attached: false, duplicate: false };
    }
    if (attachedLifecycles.has(lifecycle)) {
      return { attached: true, duplicate: true };
    }
    lifecycle.register({
      name: 'telegram-bot',
      close: () => stop('runtime-close')
    });
    attachedLifecycles.add(lifecycle);
    attachedLifecycle = lifecycle;
    return { attached: true, duplicate: false };
  }

  /**
   * 轮询消息。每次读取都带会话 signal；停止后跳出循环，不再派发更新。
   */
  async function runPolling(target: TelegramBotSession): Promise<void> {
    while (isActive(target)) {
      let delay = POLL_INTERVAL_MS;
      try {
        const updates = await getUpdates(target);
        if (!isActive(target)) break;
        for (const update of updates) {
          if (!isActive(target)) break;
          const parsed = parseUpdate(update);
          if (!parsed) {
            dependencies.logger.debug('忽略无法识别的更新', { update });
            continue;
          }
          // 不等待 handleUpdate 完成，让它在后台异步执行
          if (parsed.message) {
            handleUpdate(parsed, target).catch(error => {
              if (isActive(target)) {
                dependencies.logger.error('处理消息错误', { error: errorMessageOf(error) });
              }
            });
          }
          lastUpdateId = parsed.updateId + 1;
        }
      } catch (error) {
        if (!isActive(target) || isCancellation(error)) break;
        // 忽略多实例冲突错误（通常是因为开发时热重载导致）：
        // 出站端口把上游描述放在 details.body，错误 message 只说明状态码。
        if (!isPollingConflict(error)) {
          dependencies.logger.error('轮询错误', { error: errorMessageOf(error) });
        }
        delay = POLL_ERROR_RETRY_MS;
      }
      // 等待下一轮；会话停止会立即结束等待
      if (!await waitForSession(target, delay)) break;
    }
    if (session === target) session = null;
  }

  function isCancellation(error: unknown): boolean {
    return isOutboundRequestError(error) && error.kind === 'cancelled';
  }

  /** 兼容两种错误形态：出站端口的上游响应体在 details.body，旧形态直接在 message。 */
  function isPollingConflict(error: unknown): boolean {
    const detail = isRecord(error) && isRecord(error.details) && typeof error.details.body === 'string'
      ? error.details.body
      : '';
    return `${errorMessageOf(error)} ${detail}`.includes('Conflict: terminated by other getUpdates');
  }

  /**
   * 获取更新。POST 在出站端口内强制不自动重放；独立时限覆盖 Telegram 长轮询停留，
   * 取消由会话 signal 控制。返回值保持 unknown，由 parseUpdate 逐条校验。
   */
  async function getUpdates(target: TelegramBotSession): Promise<unknown[]> {
    const url = `${dependencies.apiBaseUrl}/bot${target.config.botToken}/getUpdates`;

    const { data } = await dependencies.outbound.requestJson(url, {
      method: 'POST',
      body: {
        offset: lastUpdateId,
        timeout: TELEGRAM_LONG_POLL_SECONDS,
        allowed_updates: ['message']
      },
      timeoutMs: TELEGRAM_LONG_POLL_TIMEOUT_MS,
      signal: target.controller.signal
    });

    return parseUpdatesPayload(data);
  }

  /** 授权规则保持：优先 allowedUserIds，否则单 ID 兼容比较 chat 或 user。 */
  function isAuthorized(message: TelegramTextMessage, config: TelegramBotConfig): boolean {
    if (config.allowedUserIds.length > 0) {
      return config.allowedUserIds.includes(message.userId);
    }
    return (message.chatId === config.chatId) || (message.userId === config.chatId);
  }

  /** 按命中来源记录既有调试日志；不在执行分支重复判断文本形态。 */
  function logCommand(command: TelegramCommandInput, text: string): void {
    switch (command.source) {
      case 'copilot-uri':
        dependencies.logger.debug('检测到作业 URI', { uri: text });
        break;
      case 'keyword':
        dependencies.logger.debug('检测到关键词', { keyword: text, command: command.name });
        break;
      case 'fight':
        dependencies.logger.debug('检测到刷关卡命令', { text });
        break;
      case 'roguelike':
        dependencies.logger.debug('检测到肉鸽命令', { text });
        break;
      case 'startup':
        dependencies.logger.debug('检测到启动游戏命令', { text });
        break;
      case 'closedown':
        dependencies.logger.debug('检测到关闭游戏命令', { text });
        break;
      case 'run':
        dependencies.logger.debug('检测到运行流程命令', { text });
        break;
      case 'slash':
        dependencies.logger.info('收到命令', { command: command.rawName, args: command.args.join(' ') });
        break;
    }
  }

  /**
   * 处理更新：授权通过后把文本解析为命令领域输入，再交给执行层。
   */
  async function handleUpdate(update: TelegramMessageUpdate, target: TelegramBotSession): Promise<void> {
    if (!isActive(target) || update.message === null) return;
    const message = update.message;

    // 忽略 Bot 自己发送的消息
    if (message.isBot) {
      return;
    }

    // 验证授权
    // 1. 如果配置了 allowedUserIds，检查用户 ID 是否在列表中
    // 2. 如果配置的是群组 ID（负数），验证 chat ID
    // 3. 如果配置的是个人 ID（正数），验证 user ID
    if (!isAuthorized(message, target.config)) {
      dependencies.logger.warn('拒绝未授权的请求', {
        chatId: message.chatId,
        userId: message.userId,
        configuredId: target.config.chatId,
        allowedUserIds: target.config.allowedUserIds
      });
      return;
    }

    const text = message.text.trim();
    const command = parseTelegramCommand(text);
    if (!command) return;

    logCommand(command, text);
    await executeCommand(message.chatId, resolveTelegramCommandRequest(command), target);
  }

  /** 需要先停止当前任务再执行的新任务命令。 */
  const TASK_COMMANDS: ReadonlySet<TelegramCommandRequest['kind']> = new Set([
    'startup',
    'fight',
    'copilot',
    'roguelike'
  ]);

  /**
   * 处理命令。派发前再次确认会话仍然有效，停止后不执行迟到命令。
   */
  async function executeCommand(
    chatId: string,
    request: TelegramCommandRequest,
    target: TelegramBotSession
  ): Promise<void> {
    if (!isActive(target)) return;
    let response: string | null = '';
    const config = target.config;

    try {
      // 如果是执行新任务的命令，先停止当前任务
      if (TASK_COMMANDS.has(request.kind)) {
        const status = dependencies.getTaskStatus();
        if (status.isRunning) {
          dependencies.logger.info('检测到新任务命令，停止当前任务', {
            currentTask: status.taskName,
            newCommand: request.kind
          });
          const stopResult = dependencies.stopCurrentTask();

          if (stopResult.success) {
            await sendMessage(chatId, `⏹️ 已强制停止当前任务: ${status.taskName}\n\n✅ 开始执行新任务...`, target);

            // 等待 2 秒让进程完全释放；会话停止会立即结束等待
            if (!await waitForSession(target, 2000)) return;
          } else {
            await sendMessage(chatId, `⚠️ ${stopResult.message}\n\n继续执行新任务...`, target);
            if (!await waitForSession(target, 1000)) return;
          }
        }
      }

      if (!isActive(target)) return;

      switch (request.kind) {
        case 'help':
          response = getHelpMessage();
          break;

        case 'status':
          response = await getStatusText();
          break;

        case 'startup':
          response = await executeStartup(request.clientType, target);
          break;

        case 'closedown':
          response = await executeClosedown(request.clientType, target);
          break;

        case 'screenshot':
          await executeScreenshot(chatId, target);
          return; // 截图命令直接返回，不发送文本消息

        case 'setcommands':
          await setupBotCommands(target);
          response = '✅ 命令菜单已更新\n\n请重新打开聊天窗口查看新菜单';
          break;

        case 'fight':
          if (request.stage === null) {
            response = '❌ 请指定关卡，例如：/fight 1-7';
          } else {
            response = await executeFight(request.stage, target);
          }
          break;

        case 'roguelike':
          response = await executeRoguelike(request.theme, target);
          break;

        case 'copilot':
          if (request.uri === null) {
            response = '❌ 请指定作业 URI，例如：/copilot prts://12345';
          } else {
            response = await executeCopilot(request.uri, target);
          }
          break;

        case 'schedule':
          response = executeScheduleTask();
          break;

        case 'stop':
          response = await stopTask();
          break;

        case 'run':
          response = await executeTaskFlow(request.flowType, target, config);
          break;

        case 'unknown':
          response = `❌ 未知命令: ${request.rawName}\n\n使用 /help 查看可用命令`;
          break;
      }
    } catch (error) {
      if (!isActive(target)) return;
      response = `❌ 执行失败: ${errorMessageOf(error)}`;
    }

    // 如果 response 不为 null，才发送消息
    if (response !== null && isActive(target)) {
      await sendMessage(chatId, response, target);
    }
  }

  /**
   * 获取帮助信息
   */
  function getHelpMessage(): string {
    return `🤖 La Pluma Next Bot 命令列表

📋 基础命令：
/help 或 帮助 - 显示此帮助信息
/status 或 状态 - 查看当前任务状态
/screenshot 或 截图 - 截取当前屏幕

🎮 游戏控制：
/startup 客户端 或 启动/开启/打开 客户端 - 启动游戏
  客户端：Official, Bilibili（默认 Official）
  例如：打开 Official 或 /startup Official

/closedown 客户端 或 关闭 客户端 - 关闭游戏
  例如：关闭 Official 或 /closedown Official

⚔️ 任务命令：
/fight 关卡 或 刷 关卡 - 执行理智作战
  例如：刷 1-7 或 /fight 1-7

/copilot URI - 执行抄作业（自动导航）
  例如：/copilot prts://12345
  或直接发送：prts://12345
  ✨ 会自动导航到关卡界面

/roguelike 主题 或 肉鸽 主题 - 执行肉鸽任务
  主题：Sami, Sarkaz, Mizuki, Phantom
  例如：肉鸽 Sami 或 /roguelike Sami

⏹️ 控制命令：
/stop 或 停止 - 停止当前任务

🔄 任务流程：
/run 流程类型 或 运行 流程类型 - 运行任务流程
  流程类型：automation（日常）, combat（作战）, roguelike（肉鸽）
  例如：运行 automation 或 /run automation
  不指定类型默认运行日常流程

💡 提示：
- 所有命令都支持中文关键词，更方便输入
- 执行任务前需要先"启动"游戏
- 任务完成后建议"关闭"游戏
- 可以直接发送 prts://12345 快速抄作业
- 可以直接发送"截图"快速截图
- 任务执行完成后会自动发送通知

📝 中文命令示例：
• 截图
• 状态
• 打开 Official
• 刷 1-7
• 肉鸽 Sami
• 运行 automation（或直接发送"日常"）
• 停止
• 关闭`;
  }

  /**
   * 获取状态
   */
  async function getStatusText(): Promise<string> {
    try {
      const status = dependencies.getTaskStatus();
      const scheduleStatus = dependencies.getScheduleExecutionStatus();

      let statusText = `📊 系统状态\n\n`;
      statusText += `✅ Bot 运行中\n`;

      // 检查是否有任务流程在运行
      if (scheduleStatus.isRunning) {
        statusText += `🎮 正在执行任务流程\n`;
        statusText += `📝 流程: ${scheduleStatus.scheduleId || '未知'}\n`;
        statusText += `📍 当前任务: ${scheduleStatus.currentTask || '未知'}\n`;
        statusText += `📊 进度: ${scheduleStatus.currentStep + 1}/${scheduleStatus.totalSteps}\n`;
        const duration = Math.floor((Date.now() - (scheduleStatus.startTime ?? Date.now())) / 1000);
        statusText += `⏱️ 运行时间: ${duration} 秒\n`;
      }
      // 检查是否有单个任务在运行
      else if (status.isRunning) {
        statusText += `🎮 正在执行任务\n`;
        statusText += `📝 当前任务: ${status.taskName || '未知'}\n`;
        const duration = Math.floor((Date.now() - (status.startTime ?? Date.now())) / 1000);
        statusText += `⏱️ 运行时间: ${duration} 秒\n`;
      }
      // 没有任务在运行
      else {
        statusText += `⏰ 等待命令...\n`;
      }

      statusText += `\n使用 /help 查看可用命令`;

      return statusText;
    } catch {
      return `📊 系统状态\n\n✅ Bot 运行中\n⏰ 等待命令...\n\n使用 /help 查看可用命令`;
    }
  }

  /**
   * 执行启动游戏
   */
  async function executeStartup(clientType: string, target: TelegramBotSession): Promise<string | null> {
    if (!isActive(target)) return null;
    try {
      await dependencies.execMaaCommand('startup', [clientType], '启动游戏', 'startup');
      return `✅ 已开始启动游戏
📱 客户端：${clientType}

游戏启动需要约 15-30 秒
请稍后再执行其他任务`;
    } catch (error) {
      throw new Error(`启动失败: ${errorMessageOf(error)}`);
    }
  }

  /**
   * 执行关闭游戏
   */
  async function executeClosedown(clientType: string, target: TelegramBotSession): Promise<string | null> {
    if (!isActive(target)) return null;
    try {
      await dependencies.execMaaCommand('closedown', [clientType], '关闭游戏', 'closedown');
      return `✅ 已关闭游戏
📱 客户端：${clientType}`;
    } catch (error) {
      throw new Error(`关闭失败: ${errorMessageOf(error)}`);
    }
  }

  /**
   * 执行截图
   */
  async function executeScreenshot(chatId: string, target: TelegramBotSession): Promise<void> {
    if (!isActive(target)) return;
    try {
      // 先发送提示消息
      await sendMessage(chatId, '📸 正在截图...', target);

      // 执行截图
      const connection = await dependencies.resolveConnection();
      if (!isActive(target)) return;
      const result = await dependencies.captureScreen(connection.adbPath, connection.address);
      if (!isActive(target)) return;

      if (result.image) {
        // 发送图片
        await sendPhoto(chatId, '📸 当前屏幕截图', result.image, target);
      } else {
        await sendMessage(chatId, '❌ 截图失败：未获取到图片数据', target);
      }
    } catch (error) {
      if (!isActive(target)) return;
      await sendMessage(chatId, `❌ 截图失败: ${errorMessageOf(error)}\n\n请检查 ADB 连接是否正常`, target);
    }
  }

  /**
   * 执行理智作战
   */
  async function executeFight(stage: string, target: TelegramBotSession): Promise<string | null> {
    if (!isActive(target)) return null;
    try {
      await dependencies.execMaaCommand('fight', [stage], `刷关卡 ${stage}`, 'combat');
      return `✅ 已开始执行理智作战
📍 关卡：${stage}

任务完成后会自动发送通知`;
    } catch (error) {
      throw new Error(`执行失败: ${errorMessageOf(error)}`);
    }
  }

  /**
   * 执行肉鸽任务
   */
  async function executeRoguelike(theme: string, target: TelegramBotSession): Promise<string | null> {
    if (!isActive(target)) return null;
    try {
      await dependencies.execMaaCommand('roguelike', [theme], `肉鸽 ${theme}`, 'roguelike');
      return `✅ 已开始执行肉鸽任务
🎯 主题：${theme}

任务完成后会自动发送通知`;
    } catch (error) {
      throw new Error(`执行失败: ${errorMessageOf(error)}`);
    }
  }

  /**
   * 执行抄作业
   */
  async function executeCopilot(uri: string, target: TelegramBotSession): Promise<string | null> {
    if (!isActive(target)) return null;
    const normalized = normalizeUri(uri);
    const config = target.config;
    try {
      // 1. 获取关卡信息
      const stageInfo = await getStageInfoFromCopilot(normalized, target);
      if (!isActive(target)) return null;
      const displayName = stageInfo?.displayName || '对应关卡';

      // 2. 提示用户手动导航
      await sendMessage(config.chatId, `✅ 准备执行抄作业
📋 作业 URI：${normalized}
📍 关卡：${displayName}

⚠️ 请在 15 秒内手动进入关卡界面

倒计时开始...`, target);

      // 3. 在后台执行倒计时和作业（不阻塞）
      (async () => {
        try {
          // 倒计时提醒
          for (let i = 15; i > 0; i--) {
            if (!await waitForSession(target, 1000)) return;
            if (i === 10 || i === 5 || i === 3 || i === 1) {
              await sendMessage(config.chatId, `⏰ ${i} 秒...`, target);
            }
          }

          if (!isActive(target)) return;
          // 执行作业
          await sendMessage(config.chatId, `🚀 开始执行作业！`, target);
          if (!isActive(target)) return;
          await dependencies.execMaaCommand('copilot', [normalized, '--formation'], `抄作业 ${normalized}`, 'copilot');
        } catch (error) {
          if (!isActive(target)) return;
          await sendMessage(config.chatId, `❌ 作业执行失败: ${errorMessageOf(error)}`, target);
        }
      })();

      // 立即返回，不等待倒计时完成
      return `✅ 倒计时已开始

任务完成后会自动发送通知`;
    } catch (error) {
      throw new Error(`执行失败: ${errorMessageOf(error)}`);
    }
  }

  /**
   * 内部关卡代号到显示名称的映射表
   * 用于无法从标题获取关卡名的情况
   */
  const STAGE_NAME_MAP: Record<string, string> = {
    // 活动关卡示例（需要根据实际情况补充）
    'act40side_ex08': 'OR-EX-8',
    'act40side_ex07': 'OR-EX-7',
    'act40side_ex06': 'OR-EX-6',
    'act40side_ex05': 'OR-EX-5',
    'act40side_ex04': 'OR-EX-4',
    'act40side_ex03': 'OR-EX-3',
    'act40side_ex02': 'OR-EX-2',
    'act40side_ex01': 'OR-EX-1',
    // 可以继续添加其他活动关卡...
  };

  interface CopilotStageInfo {
    stageName: string | null;
    displayName: string | null;
  }

  /**
   * 从作业 URI 获取关卡信息
   */
  async function getStageInfoFromCopilot(
    uri: string,
    target: TelegramBotSession
  ): Promise<CopilotStageInfo | null> {
    try {
      const parsed = readCopilotUri(uri);
      if (parsed && !parsed.isSet) {
        const code = parsed.id;
        const apiUrl = `${dependencies.copilotApiBaseUrl}/copilot/get/${code}`;

        const { data } = await dependencies.outbound.requestJson(apiUrl, {
          signal: target.controller.signal
        });

        const payload = isRecord(data) ? data : null;
        const inner = payload && isRecord(payload.data) ? payload.data : null;
        const rawContent = inner?.content;

        if (rawContent) {
          // 上游 content 是 JSON 字符串；非字符串视为非法载荷，与外层解析失败同样回落到 null。
          if (typeof rawContent !== 'string') {
            throw new Error('Copilot 作业内容格式无效');
          }
          const content: unknown = JSON.parse(rawContent);
          const doc = isRecord(content) && isRecord(content.doc) ? content.doc : null;
          // 标题在 content.doc.title 里面（不是 data.data.doc.title）
          const title = doc && typeof doc.title === 'string' ? doc.title : '';
          dependencies.logger.debug('Copilot 作业标题', { title });

          // 从标题提取显示名称（最重要）
          let displayName: string | null = null;
          if (title) {
            // 尝试多种格式匹配
            // 格式1: "OR-EX-8 xxx" 或 "OR-EX-8"
            let titleMatch = title.match(/^([A-Z]{1,3}-[A-Z]{1,3}-\d+)/);
            if (!titleMatch) {
              // 格式2: "1-7 xxx" 或 "1-7"
              titleMatch = title.match(/^(\d+-\d+)/);
            }
            if (!titleMatch) {
              // 格式3: "CE-6 xxx" 或 "CE-6"
              titleMatch = title.match(/^([A-Z]{1,3}-\d+)/);
            }
            if (!titleMatch) {
              // 格式4: 标题中包含关卡名，如 "【OR-EX-8】xxx" 或 "[OR-EX-8] xxx"
              titleMatch = title.match(/[【\[]([A-Z]{1,3}-[A-Z]{1,3}-\d+)[】\]]/);
            }
            if (!titleMatch) {
              // 格式5: 标题中包含关卡名，如 "【1-7】xxx"
              titleMatch = title.match(/[【\[](\d+-\d+)[】\]]/);
            }
            if (!titleMatch) {
              // 格式6: 任何位置的关卡名模式
              titleMatch = title.match(/([A-Z]{1,3}-[A-Z]{1,3}-\d+)/);
            }
            if (!titleMatch) {
              titleMatch = title.match(/(\d+-\d+)/);
            }

            if (titleMatch) {
              displayName = titleMatch[1];
            }
          }

          const stageName = isRecord(content) && typeof content.stage_name === 'string'
            ? content.stage_name
            : null;

          // 如果标题中没有找到，尝试从映射表查找
          if (!displayName && stageName) {
            displayName = STAGE_NAME_MAP[stageName] || null;
            if (displayName) {
              dependencies.logger.debug('从映射表找到关卡名', { displayName });
            }
          }

          dependencies.logger.debug('Copilot 关卡信息', { displayName, stageName });

          return {
            stageName,        // 内部代号
            displayName       // 显示名称（用于导航）
          };
        }
      } else if (uri.endsWith('.json')) {
        const { readFile } = await import('fs/promises');
        const fileContent = await readFile(uri, 'utf-8');
        const data: unknown = JSON.parse(fileContent);
        return {
          stageName: isRecord(data) && typeof data.stage_name === 'string' ? data.stage_name : null,
          displayName: null
        };
      }

      return null;
    } catch (error) {
      dependencies.logger.error('Copilot 获取关卡信息失败', { error: errorMessageOf(error) });
      return null;
    }
  }

  /**
   * 执行定时任务
   */
  function executeScheduleTask(): string {
    // Bot 无法取得 WebUI 中保存的 taskFlow，只提供明确的替代入口。
    return `❌ 暂不支持通过 Bot 执行定时任务

请使用以下命令：
/fight <关卡> - 执行理智作战
/roguelike [主题] - 执行肉鸽任务`;
  }

  /**
   * 停止当前任务
   */
  async function stopTask(): Promise<string> {
    try {
      const result = dependencies.stopCurrentTask();
      if (result.success) {
        return `⏹️ 已发送停止信号

当前任务将在完成当前步骤后停止`;
      } else {
        return `ℹ️ ${result.message || '当前没有正在运行的任务'}`;
      }
    } catch (error) {
      throw new Error(`停止失败: ${errorMessageOf(error)}`);
    }
  }

  /**
   * 执行任务流程。
   *
   * 未纳管的 Bot 入口保持现行契约：直接调用 schedulerService.executeScheduleNow，
   * 不创建 HTTP Run 包装；Run/租约投影由 runSnapshotService 按外部占用识别。
   */
  async function executeTaskFlow(
    flowType: string,
    target: TelegramBotSession,
    config: TelegramBotConfig
  ): Promise<string | null> {
    if (!isActive(target)) return null;
    try {
      // 验证流程类型
      const validTypes = ['automation', 'combat', 'roguelike'];
      if (!validTypes.includes(flowType)) {
        return `❌ 无效的流程类型: ${flowType}

支持的流程类型：
• automation - 日常流程
• combat - 作战流程
• roguelike - 肉鸽流程`;
      }

      // 获取流程名称
      const flowNames: Record<string, string> = {
        'automation': '日常流程',
        'combat': '作战流程',
        'roguelike': '肉鸽流程'
      };

      const flowName = flowNames[flowType];

      // 任务流程配置经用户配置存储端口读取：类型在白名单内，缺失与损坏
      // 都有明确结果，不再直读 data/user-configs 下的文件。
      const configResult = await dependencies.loadUserConfig(`${flowType}-tasks`);
      if (!configResult.success) {
        throw new Error(configResult.message || '读取任务流程配置失败');
      }
      if (!isActive(target)) return null;
      const flowConfig: unknown = configResult.data;

      // 获取任务流程：非数组按未配置处理，单条配置只读取对象条目。
      const taskFlow: unknown[] = isRecord(flowConfig) && Array.isArray(flowConfig.taskFlow)
        ? flowConfig.taskFlow
        : [];

      if (taskFlow.length === 0) {
        return `❌ ${flowName}未配置任何任务

请先在 WebUI 中配置任务流程`;
      }

      const enabledCount = taskFlow.filter(task => isRecord(task) && Boolean(task.enabled)).length;

      // 发送初始状态消息
      const initialMessage = await sendMessage(config.chatId, `✅ 已开始执行${flowName}

📊 准备执行 ${enabledCount} 个任务...`, target);

      // 获取消息 ID 用于后续编辑
      const messageId = readMessageId(initialMessage);

      // 在后台执行流程并实时更新状态
      if (messageId !== null) {
        let stopInterval: (() => void) | null = null;
        const updateProgress = async (): Promise<void> => {
          const scheduleStatus = dependencies.getScheduleExecutionStatus();

          if (!scheduleStatus.isRunning) {
            // 任务完成，停止更新
            stopInterval?.();
            if (!isActive(target)) return;
            await editMessage(config.chatId, messageId, `✅ ${flowName}执行完成

任务已全部完成
详细结果请查看通知消息`, target);
            return;
          }

          // 构建状态文本
          const duration = Math.floor((Date.now() - (scheduleStatus.startTime ?? Date.now())) / 1000);
          const minutes = Math.floor(duration / 60);
          const seconds = duration % 60;
          const timeStr = minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;

          const statusText = `🔄 正在执行${flowName}

📍 当前任务: ${scheduleStatus.currentTask || '准备中...'}
📊 进度: ${scheduleStatus.currentStep + 1}/${scheduleStatus.totalSteps}
⏱️ 运行时间: ${timeStr}

请稍候...`;

          await editMessage(config.chatId, messageId, statusText, target);
        };
        stopInterval = startSessionInterval(target, updateProgress, 3000); // 每3秒更新一次
      }

      // 执行流程（不等待完成）；停止后不再启动新流程
      if (!isActive(target)) return null;
      Promise.resolve(dependencies.executeScheduleNow(flowType, taskFlow)).catch(error => {
        dependencies.logger.error('任务流程执行失败', { error: errorMessageOf(error) });
        if (messageId !== null && isActive(target)) {
          editMessage(config.chatId, messageId, `❌ ${flowName}执行失败

错误: ${errorMessageOf(error)}`, target);
        }
      });

      return null; // 不返回消息，因为已经发送了初始消息
    } catch (error) {
      throw new Error(`执行失败: ${errorMessageOf(error)}`);
    }
  }

  /** 只读取既有响应的 message_id；非数字按无消息 ID 处理，不启动进度编辑。 */
  function readMessageId(response: TelegramApiResponse | undefined): number | null {
    const messageId = response?.result?.message_id;
    return typeof messageId === 'number' ? messageId : null;
  }

  /**
   * 发送消息。写入类请求不自动重放；失败沿用既有语义：记录日志并返回上游载荷。
   */
  async function sendMessage(
    chatId: string,
    text: string,
    target: TelegramBotSession
  ): Promise<TelegramApiResponse | undefined> {
    const url = `${dependencies.apiBaseUrl}/bot${target.config.botToken}/sendMessage`;

    try {
      const { data } = await dependencies.outbound.requestJson(url, {
        method: 'POST',
        body: {
          chat_id: chatId,
          text: text,
          parse_mode: 'Markdown'  // 改用 Markdown 而不是 HTML
        },
        signal: target.controller.signal
      });

      const response = parseTelegramApiResponse(data);
      if (!response.ok) {
        dependencies.logger.error('发送消息失败', { description: response.description });
      }

      return response; // 返回完整响应，包含 message_id
    } catch (error) {
      if (isActive(target)) {
        dependencies.logger.error('发送消息错误', { error: errorMessageOf(error) });
      }
      return undefined;
    }
  }

  /**
   * 编辑消息
   */
  async function editMessage(
    chatId: string,
    messageId: number,
    text: string,
    target: TelegramBotSession
  ): Promise<TelegramApiResponse | undefined> {
    const url = `${dependencies.apiBaseUrl}/bot${target.config.botToken}/editMessageText`;

    try {
      const { data } = await dependencies.outbound.requestJson(url, {
        method: 'POST',
        body: {
          chat_id: chatId,
          message_id: messageId,
          text: text,
          parse_mode: 'Markdown'
        },
        signal: target.controller.signal
      });

      const response = parseTelegramApiResponse(data);
      if (!response.ok) {
        // 如果消息内容没有变化，Telegram 会返回错误，这是正常的
        if (!response.description?.includes('message is not modified')) {
          dependencies.logger.error('编辑消息失败', { description: response.description });
        }
      }

      return response;
    } catch (error) {
      if (isActive(target)) {
        dependencies.logger.error('编辑消息错误', { error: errorMessageOf(error) });
      }
      return undefined;
    }
  }

  /**
   * 发送图片。原生 FormData/Blob 承载 multipart，字段、文件名与图片字节保持一致，
   * 编码与 boundary 由运行时完成；上传使用 30 秒时限并绑定会话 signal。
   */
  async function sendPhoto(
    chatId: string,
    caption: string,
    imageBase64: string,
    target: TelegramBotSession
  ): Promise<void> {
    const url = `${dependencies.apiBaseUrl}/bot${target.config.botToken}/sendPhoto`;

    try {
      // 将 base64 转换为 Buffer
      const imageBuffer = Buffer.from(imageBase64, 'base64');

      const formData = new FormData();
      formData.append('chat_id', chatId);
      formData.append('photo', new Blob([imageBuffer], { type: 'image/png' }), 'screenshot.png');
      formData.append('caption', caption);

      const { data } = await dependencies.outbound.requestMultipart(url, {
        formData,
        timeoutMs: PHOTO_TIMEOUT_MS,
        signal: target.controller.signal
      });

      const response = parseTelegramApiResponse(data);
      if (!response.ok) {
        dependencies.logger.error('发送图片失败', { description: response.description });
        throw new Error(response.description ?? '');
      }
    } catch (error) {
      if (isActive(target)) {
        dependencies.logger.error('发送图片错误', { error: errorMessageOf(error) });
      }
      throw error;
    }
  }

  interface TelegramBotCommandMenuEntry {
    command: string;
    description: string;
  }

  /**
   * 设置 Bot 命令菜单
   */
  async function setupBotCommands(target: TelegramBotSession): Promise<void> {
    const config = target.config;

    // 先删除所有旧命令
    const deleteUrl = `${dependencies.apiBaseUrl}/bot${config.botToken}/deleteMyCommands`;

    try {
      await dependencies.outbound.requestJson(deleteUrl, {
        method: 'POST',
        body: {},
        signal: target.controller.signal
      });
      dependencies.logger.debug('已删除旧命令');
    } catch (error) {
      if (isActive(target)) {
        dependencies.logger.error('删除旧命令失败', { error: errorMessageOf(error) });
      }
    }

    // 设置新命令
    const url = `${dependencies.apiBaseUrl}/bot${config.botToken}/setMyCommands`;

    const commands: TelegramBotCommandMenuEntry[] = [
      { command: 'help', description: '显示帮助信息' },
      { command: 'status', description: '查看当前任务状态' },
      { command: 'screenshot', description: '截取当前屏幕' },
      { command: 'startup', description: '启动游戏 (例: /startup Official)' },
      { command: 'closedown', description: '关闭游戏' },
      { command: 'fight', description: '执行理智作战 (例: /fight 1-7)' },
      { command: 'roguelike', description: '执行肉鸽任务 (例: /roguelike Sami)' },
      { command: 'run', description: '运行任务流程 (例: /run automation)' },
      { command: 'stop', description: '停止当前任务' }
    ];

    try {
      const { data } = await dependencies.outbound.requestJson(url, {
        method: 'POST',
        body: { commands },
        signal: target.controller.signal
      });

      const response = parseTelegramApiResponse(data);
      if (response.ok) {
        dependencies.logger.debug('命令菜单设置成功');
      } else {
        dependencies.logger.error('命令菜单设置失败', { description: response.description });
      }
    } catch (error) {
      if (isActive(target)) {
        dependencies.logger.error('设置命令菜单错误', { error: errorMessageOf(error) });
      }
    }
  }

  return {
    init,
    stop,
    attachLifecycle,
    getStatus
  };
}

/** 进程级默认实例：绑定真实出站端口、MAA 服务与配置存储。 */
export const telegramBotService = createTelegramBotService();

export const initTelegramBot = (config?: unknown): TelegramBotStatus => telegramBotService.init(config);
export const stopTelegramBot = (reason?: string): Promise<TelegramBotStopResult> => telegramBotService.stop(reason);
export const attachTelegramBotToLifecycle = (
  lifecycle?: RuntimeLifecycle | null
): TelegramLifecycleAttachment => telegramBotService.attachLifecycle(lifecycle);
