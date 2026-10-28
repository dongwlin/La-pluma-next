import { loadUserConfig } from './configStorageService.ts';
import { resolveConnection } from './connectionService.js';
import { getNotificationConfig, setNotificationConfig } from './notificationService.js';
import {
  attachScheduleTriggersToLifecycle,
  setupAutoUpdate,
  setupSchedule
} from './schedulerService.js';
import { initTelegramBot, attachTelegramBotToLifecycle } from './telegramBotService.js';
import { createLogger } from '../utils/logger.ts';

const logger = createLogger('RuntimeInitialization');

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

async function readPersistedConfig(configType, loadConfig, runtimeLogger) {
  try {
    const result = await loadConfig(configType);
    if (!result?.success) {
      runtimeLogger.warn('运行时配置加载失败', { configType, message: result?.message || '未知错误' });
      return null;
    }
    return isObject(result.data) ? result.data : null;
  } catch (error) {
    runtimeLogger.error('运行时配置加载异常', { configType, error: error.message });
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
export async function initializeRuntimeState(overrides = {}) {
  const { lifecycle, ...dependencyOverrides } = overrides;
  const dependencies = {
    loadConfig: loadUserConfig,
    applyNotificationConfig: setNotificationConfig,
    readNotificationConfig: getNotificationConfig,
    registerSchedule: setupSchedule,
    registerAutoUpdate: setupAutoUpdate,
    attachScheduleLifecycle: attachScheduleTriggersToLifecycle,
    attachTelegramLifecycle: attachTelegramBotToLifecycle,
    resolveRuntimeConnection: resolveConnection,
    startTelegramBot: initTelegramBot,
    runtimeLogger: logger,
    ...dependencyOverrides
  };

  if (lifecycle && typeof dependencies.attachScheduleLifecycle === 'function') {
    try {
      dependencies.attachScheduleLifecycle(lifecycle);
    } catch (error) {
      dependencies.runtimeLogger.error('调度触发源生命周期接入失败', { error: error.message });
    }
  }

  const summary = {
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
      summary.notification.error = error.message;
      dependencies.runtimeLogger.error('通知配置恢复失败', { error: error.message });
    }
  }

  const persistedSchedule = automationConfig?.schedule;
  if (persistedSchedule?.enabled) {
    try {
      const result = dependencies.registerSchedule(
        'default',
        Array.isArray(persistedSchedule.times) ? persistedSchedule.times : [],
        Array.isArray(automationConfig.taskFlow) ? automationConfig.taskFlow : []
      );
      summary.schedule = {
        restored: Boolean(result?.success),
        message: result?.message || null
      };
      if (!result?.success) {
        dependencies.runtimeLogger.warn('默认定时任务恢复失败', { message: result?.message || '未知错误' });
      }
    } catch (error) {
      summary.schedule.error = error.message;
      dependencies.runtimeLogger.error('默认定时任务恢复异常', { error: error.message });
    }
  }

  if (autoUpdateConfig?.enabled) {
    try {
      const result = dependencies.registerAutoUpdate(autoUpdateConfig);
      summary.autoUpdate = {
        restored: Boolean(result?.success),
        message: result?.message || null
      };
      if (!result?.success) {
        dependencies.runtimeLogger.warn('自动更新任务恢复失败', { message: result?.message || '未知错误' });
      }
    } catch (error) {
      summary.autoUpdate.error = error.message;
      dependencies.runtimeLogger.error('自动更新任务恢复异常', { error: error.message });
    }
  }

  try {
    const telegramConfig = dependencies.readNotificationConfig()?.channels?.telegram;
    if (telegramConfig) {
      const connection = await dependencies.resolveRuntimeConnection();
      const botConfig = {
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
          dependencies.runtimeLogger.error('Telegram 生命周期接入失败', { error: error.message });
          throw error;
        }
      }
      dependencies.startTelegramBot(botConfig);
      summary.telegram.initialized = enabled;
    }
  } catch (error) {
    summary.telegram.error = error.message;
    dependencies.runtimeLogger.error('Telegram Bot 初始化失败', { error: error.message });
  }

  dependencies.runtimeLogger.info('运行时配置恢复完成', {
    notification: summary.notification.restored,
    schedule: summary.schedule.restored,
    autoUpdate: summary.autoUpdate.restored,
    telegram: summary.telegram.initialized
  });

  return summary;
}
