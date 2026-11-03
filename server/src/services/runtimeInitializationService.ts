import { loadUserConfig } from './configStorageService.ts';
import { resolveConnection } from './connectionService.ts';
import { getNotificationConfig, setNotificationConfig } from './notificationService.ts';
import type { NotificationChannelConfig } from './notificationService.ts';
import {
  attachScheduleTriggersToLifecycle,
  setupAutoUpdate,
  setupSchedule
} from './schedulerService.ts';
import type { AutoUpdateConfig } from './scheduleTriggerService.ts';
import { initTelegramBot, attachTelegramBotToLifecycle } from './telegramBotService.ts';
import type { RuntimeLifecycle } from './runtimeLifecycleService.ts';
import { createLogger } from '../utils/logger.ts';
import { waitWithAbort } from '../utils/abort.ts';

const logger = createLogger('RuntimeInitialization');

/** 恢复结果的最小形状：真实服务返回带 message 的对象，测试注入只关心成功位。 */
export interface RuntimeSetupOutcome {
  success?: unknown;
  message?: unknown;
}

/** 持久配置读取结果的最小形状；恢复只读成功位、消息与未解析的 `data`。 */
export interface RuntimeConfigLoadOutcome {
  success?: unknown;
  message?: unknown;
  data?: unknown;
}

/** 当前通知配置的最小视图：只读渠道表，渠道字段由通知服务拥有。 */
export interface RuntimeNotificationState {
  channels?: Record<string, NotificationChannelConfig>;
}

export interface RuntimeConnectionSnapshot {
  adbPath?: string;
  address?: string;
  /** 当前 profile 的客户端类型；缺失时定时任务按连接默认客户端注册。 */
  clientType?: string;
}

/** Telegram 启动配置：持久渠道字段原样透传，另附解析后的连接信息。 */
export type TelegramRuntimeConfig = NotificationChannelConfig & {
  adbPath?: string;
  adbAddress?: string;
};

export interface RuntimeInitializationLogger {
  info(message: string, data?: unknown): unknown;
  warn(message: string, data?: unknown): unknown;
  error(message: string, data?: unknown): unknown;
}

/**
 * 依赖端口按本模块实际读取的能力声明，不复制各领域完整服务类型；
 * 组装入口注入真实实现，测试只替换相关端口。
 */
export interface RuntimeInitializationPorts {
  loadConfig(configType: string): Promise<RuntimeConfigLoadOutcome>;
  applyNotificationConfig(config: unknown): unknown;
  readNotificationConfig(): RuntimeNotificationState;
  registerSchedule(
    scheduleId: string,
    times: unknown,
    taskFlow: unknown,
    clientType?: string
  ): RuntimeSetupOutcome;
  registerAutoUpdate(config: AutoUpdateConfig): RuntimeSetupOutcome;
  attachScheduleLifecycle(lifecycle: RuntimeLifecycle): unknown;
  attachTelegramLifecycle(lifecycle: RuntimeLifecycle): unknown;
  resolveRuntimeConnection(): Promise<RuntimeConnectionSnapshot>;
  startTelegramBot(config: TelegramRuntimeConfig): unknown;
  runtimeLogger: RuntimeInitializationLogger;
}

export interface RuntimeInitializationOverrides extends Partial<RuntimeInitializationPorts> {
  lifecycle?: RuntimeLifecycle | null;
  signal?: AbortSignal;
}

/** 恢复摘要：每个领域独立记录成功位与失败原因，互不替代。 */
export interface RuntimeInitializationSummary {
  notification: { restored: boolean; error?: string };
  schedule: { restored: boolean; message?: string | null; error?: string };
  autoUpdate: { restored: boolean; message?: string | null; error?: string };
  telegram: { initialized: boolean; error?: string };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readOutcomeMessage(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

async function readPersistedConfig(
  configType: string,
  loadConfig: RuntimeInitializationPorts['loadConfig'],
  runtimeLogger: RuntimeInitializationLogger,
  signal?: AbortSignal
): Promise<Record<string, unknown> | null> {
  try {
    const result = await waitWithAbort(() => loadConfig(configType), signal);
    signal?.throwIfAborted();
    if (!result.success) {
      runtimeLogger.warn('运行时配置加载失败', {
        configType,
        message: typeof result.message === 'string' && result.message ? result.message : '未知错误'
      });
      return null;
    }
    return isObject(result.data) ? result.data : null;
  } catch (error) {
    signal?.throwIfAborted();
    runtimeLogger.error('运行时配置加载异常', { configType, error: readErrorMessage(error) });
    return null;
  }
}

/**
 * 恢复已保存的通知、定时任务、自动更新与 Telegram 配置；只注册触发源，不执行流程。
 * 调度停止端口在读取持久配置前挂接，Telegram 停止端口在启动轮询前挂接且失败即不启动，
 * 否则关闭流程无法回收之后通过 API 注册的 cron/自动更新或后台长轮询。
 */
export async function initializeRuntimeState(
  overrides: RuntimeInitializationOverrides = {}
): Promise<RuntimeInitializationSummary> {
  const { lifecycle, signal, ...dependencyOverrides } = overrides;
  signal?.throwIfAborted();
  const dependencies: RuntimeInitializationPorts = {
    loadConfig: dependencyOverrides.loadConfig ?? loadUserConfig,
    applyNotificationConfig: dependencyOverrides.applyNotificationConfig ?? setNotificationConfig,
    readNotificationConfig: dependencyOverrides.readNotificationConfig ?? getNotificationConfig,
    registerSchedule: dependencyOverrides.registerSchedule ?? setupSchedule,
    registerAutoUpdate: dependencyOverrides.registerAutoUpdate ?? setupAutoUpdate,
    attachScheduleLifecycle: dependencyOverrides.attachScheduleLifecycle ?? attachScheduleTriggersToLifecycle,
    attachTelegramLifecycle: dependencyOverrides.attachTelegramLifecycle ?? attachTelegramBotToLifecycle,
    resolveRuntimeConnection: dependencyOverrides.resolveRuntimeConnection ?? resolveConnection,
    startTelegramBot: dependencyOverrides.startTelegramBot ?? initTelegramBot,
    runtimeLogger: dependencyOverrides.runtimeLogger ?? logger
  };

  if (lifecycle && typeof dependencies.attachScheduleLifecycle === 'function') {
    try {
      dependencies.attachScheduleLifecycle(lifecycle);
    } catch (error) {
      dependencies.runtimeLogger.error('调度触发源生命周期接入失败', { error: readErrorMessage(error) });
    }
  }

  const summary: RuntimeInitializationSummary = {
    notification: { restored: false },
    schedule: { restored: false },
    autoUpdate: { restored: false },
    telegram: { initialized: false }
  };

  const [notificationConfig, automationConfig, autoUpdateConfig] = await Promise.all([
    readPersistedConfig('notification', dependencies.loadConfig, dependencies.runtimeLogger, signal),
    readPersistedConfig('automation-tasks', dependencies.loadConfig, dependencies.runtimeLogger, signal),
    readPersistedConfig('auto-update', dependencies.loadConfig, dependencies.runtimeLogger, signal)
  ]);
  signal?.throwIfAborted();

  if (notificationConfig) {
    try {
      dependencies.applyNotificationConfig(notificationConfig);
      summary.notification.restored = true;
    } catch (error) {
      summary.notification.error = readErrorMessage(error);
      dependencies.runtimeLogger.error('通知配置恢复失败', { error: readErrorMessage(error) });
    }
  }

  const persistedSchedule = isObject(automationConfig?.schedule) ? automationConfig.schedule : null;
  signal?.throwIfAborted();
  if (persistedSchedule?.enabled) {
    try {
      // 恢复的定时任务沿用当前 profile 的客户端时区；解析失败不阻断恢复。
      let clientType: string | undefined;
      try {
        const connection = await waitWithAbort(() => dependencies.resolveRuntimeConnection(), signal);
        signal?.throwIfAborted();
        clientType = connection.clientType;
      } catch (error) {
        signal?.throwIfAborted();
        dependencies.runtimeLogger.warn('读取连接配置失败，默认定时任务按默认客户端时区恢复', {
          error: readErrorMessage(error)
        });
      }
      const result = dependencies.registerSchedule(
        'default',
        Array.isArray(persistedSchedule.times) ? persistedSchedule.times : [],
        Array.isArray(automationConfig?.taskFlow) ? automationConfig.taskFlow : [],
        clientType
      );
      summary.schedule = {
        restored: Boolean(result?.success),
        message: readOutcomeMessage(result?.message)
      };
      if (!result?.success) {
        dependencies.runtimeLogger.warn('默认定时任务恢复失败', { message: readOutcomeMessage(result?.message) ?? '未知错误' });
      }
    } catch (error) {
      summary.schedule.error = readErrorMessage(error);
      dependencies.runtimeLogger.error('默认定时任务恢复异常', { error: readErrorMessage(error) });
    }
  }

  signal?.throwIfAborted();
  if (autoUpdateConfig?.enabled) {
    try {
      const result = dependencies.registerAutoUpdate(autoUpdateConfig);
      summary.autoUpdate = {
        restored: Boolean(result?.success),
        message: readOutcomeMessage(result?.message)
      };
      if (!result?.success) {
        dependencies.runtimeLogger.warn('自动更新任务恢复失败', { message: readOutcomeMessage(result?.message) ?? '未知错误' });
      }
    } catch (error) {
      summary.autoUpdate.error = readErrorMessage(error);
      dependencies.runtimeLogger.error('自动更新任务恢复异常', { error: readErrorMessage(error) });
    }
  }

  try {
    signal?.throwIfAborted();
    const telegramConfig = dependencies.readNotificationConfig()?.channels?.telegram;
    if (telegramConfig) {
      const connection = await waitWithAbort(() => dependencies.resolveRuntimeConnection(), signal);
      signal?.throwIfAborted();
      const botConfig: TelegramRuntimeConfig = {
        ...telegramConfig,
        adbPath: connection.adbPath,
        adbAddress: connection.address
      };
      const enabled = Boolean(telegramConfig.enabled && telegramConfig.botToken && telegramConfig.chatId);
      if (enabled && lifecycle && typeof dependencies.attachTelegramLifecycle === 'function') {
        try {
          dependencies.attachTelegramLifecycle(lifecycle);
        } catch (error) {
          // 没有停止端口的后台轮询会在关闭后继续运行，因此宁可本次不启动。
          dependencies.runtimeLogger.error('Telegram 生命周期接入失败', { error: readErrorMessage(error) });
          throw error;
        }
      }
      signal?.throwIfAborted();
      dependencies.startTelegramBot(botConfig);
      summary.telegram.initialized = enabled;
    }
  } catch (error) {
    signal?.throwIfAborted();
    summary.telegram.error = readErrorMessage(error);
    dependencies.runtimeLogger.error('Telegram Bot 初始化失败', { error: readErrorMessage(error) });
  }

  dependencies.runtimeLogger.info('运行时配置恢复完成', {
    notification: summary.notification.restored,
    schedule: summary.schedule.restored,
    autoUpdate: summary.autoUpdate.restored,
    telegram: summary.telegram.initialized
  });

  return summary;
}
