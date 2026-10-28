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

const logger = createLogger('RuntimeInitialization');

/**
 * 恢复结果中使用的配置/注册返回值：真实服务返回带 message 的结果对象，
 * 测试注入的实现只关心成功位，因此这里按最小可用字段收窄。
 */
export interface RuntimeSetupOutcome {
  success?: unknown;
  message?: unknown;
}

/**
 * 持久配置读取结果的最小形状。写入磁盘的是用户配置文档，字段语义由各
 * 领域在其边界收窄；运行时恢复只读成功位、消息与未解析的 data。
 */
export interface RuntimeConfigLoadOutcome {
  success?: unknown;
  message?: unknown;
  data?: unknown;
}

/** 当前通知配置的最小视图：只读渠道表，渠道字段由通知服务拥有。 */
export interface RuntimeNotificationState {
  channels?: Record<string, NotificationChannelConfig>;
}

/** 连接解析端口只提供 Telegram 启动所需的连接字段。 */
export interface RuntimeConnectionSnapshot {
  adbPath?: string;
  address?: string;
}

/** Telegram 启动配置：持久渠道字段原样透传，另附解析后的连接信息。 */
export type TelegramRuntimeConfig = NotificationChannelConfig & {
  adbPath?: string;
  adbAddress?: string;
};

/** 运行时初始化日志端口：只需三个级别。 */
export interface RuntimeInitializationLogger {
  info(message: string, data?: unknown): unknown;
  warn(message: string, data?: unknown): unknown;
  error(message: string, data?: unknown): unknown;
}

/**
 * 运行时恢复的依赖端口：组装入口注入真实实现，测试只替换相关端口。
 * 端口按“本模块实际读取的能力”声明，不复制各领域的完整服务类型。
 */
export interface RuntimeInitializationPorts {
  loadConfig(configType: string): Promise<RuntimeConfigLoadOutcome>;
  applyNotificationConfig(config: unknown): unknown;
  readNotificationConfig(): RuntimeNotificationState;
  registerSchedule(scheduleId: string, times: unknown, taskFlow: unknown): RuntimeSetupOutcome;
  registerAutoUpdate(config: AutoUpdateConfig): RuntimeSetupOutcome;
  attachScheduleLifecycle(lifecycle: RuntimeLifecycle): unknown;
  attachTelegramLifecycle(lifecycle: RuntimeLifecycle): unknown;
  resolveRuntimeConnection(): Promise<RuntimeConnectionSnapshot>;
  startTelegramBot(config: TelegramRuntimeConfig): unknown;
  runtimeLogger: RuntimeInitializationLogger;
}

/** 可注入端口与生命周期；未提供的端口使用默认实现。 */
export interface RuntimeInitializationOverrides extends Partial<RuntimeInitializationPorts> {
  lifecycle?: RuntimeLifecycle | null;
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

/** 返回值只保留字符串 message；缺失或非字符串按无消息处理。 */
function readOutcomeMessage(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

async function readPersistedConfig(
  configType: string,
  loadConfig: RuntimeInitializationPorts['loadConfig'],
  runtimeLogger: RuntimeInitializationLogger
): Promise<Record<string, unknown> | null> {
  try {
    const result = await loadConfig(configType);
    if (!result.success) {
      runtimeLogger.warn('运行时配置加载失败', {
        configType,
        message: typeof result.message === 'string' && result.message ? result.message : '未知错误'
      });
      return null;
    }
    return isObject(result.data) ? result.data : null;
  } catch (error) {
    runtimeLogger.error('运行时配置加载异常', { configType, error: readErrorMessage(error) });
    return null;
  }
}

/**
 * 恢复已保存的通知、定时任务、自动更新与 Telegram 配置。
 * 所有副作用通过 overrides 注入；组装入口同时传入 lifecycle 关闭端口，
 * 供具体领域把已启动后台任务的停止能力注册到同一次关闭流程。
 *
 * 调度触发源的停止端口在读取持久配置前挂接：即使没有已保存配置或恢复失败，
 * 关闭时也能停止之后通过 API 注册的 cron/自动更新。恢复只注册触发源，不执行流程。
 *
 * Telegram 的关闭步骤在实际启动轮询前挂接：只有启用了 Bot 才需要停止端口，
 * 挂接失败时不启动轮询，避免出现关闭流程无法回收的后台长轮询。
 */
export async function initializeRuntimeState(
  overrides: RuntimeInitializationOverrides = {}
): Promise<RuntimeInitializationSummary> {
  const { lifecycle, ...dependencyOverrides } = overrides;
  // 未提供的端口回落到真实实现；显式传入的实现优先，包括测试的假实现。
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
    readPersistedConfig('notification', dependencies.loadConfig, dependencies.runtimeLogger),
    readPersistedConfig('automation-tasks', dependencies.loadConfig, dependencies.runtimeLogger),
    readPersistedConfig('auto-update', dependencies.loadConfig, dependencies.runtimeLogger)
  ]);

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
  if (persistedSchedule?.enabled) {
    try {
      const result = dependencies.registerSchedule(
        'default',
        Array.isArray(persistedSchedule.times) ? persistedSchedule.times : [],
        Array.isArray(automationConfig?.taskFlow) ? automationConfig.taskFlow : []
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
    const telegramConfig = dependencies.readNotificationConfig()?.channels?.telegram;
    if (telegramConfig) {
      const connection = await dependencies.resolveRuntimeConnection();
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
      dependencies.startTelegramBot(botConfig);
      summary.telegram.initialized = enabled;
    }
  } catch (error) {
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
