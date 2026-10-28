import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { initializeRuntimeState } from '../runtimeInitializationService.ts';
import type {
  RuntimeInitializationLogger,
  TelegramRuntimeConfig
} from '../runtimeInitializationService.ts';
import type {
  RuntimeLifecycle,
  RuntimeLifecycleCloseSummary,
  RuntimeLifecycleStartSummary,
  RuntimeLifecycleState,
  RuntimeLifecycleStep
} from '../runtimeLifecycleService.ts';

const silentLogger: RuntimeInitializationLogger = {
  info() {},
  warn() {},
  error() {}
};

/**
 * 最小生命周期夹具：只实现注册与逆序关闭，其余查询返回固定值，
 * 用来断言恢复过程把停止端口挂到同一个生命周期上。
 */
interface FakeLifecycle extends RuntimeLifecycle {
  steps: RuntimeLifecycleStep[];
}

function createFakeLifecycle(): FakeLifecycle {
  let draining = false;
  let state: RuntimeLifecycleState = 'idle';
  const steps: RuntimeLifecycleStep[] = [];
  return {
    steps,
    register(step) {
      steps.push(step);
    },
    isDraining: () => draining,
    getState: () => state,
    getCloseSummary: () => null,
    async start(): Promise<RuntimeLifecycleStartSummary> {
      state = 'running';
      return { started: [], durationMs: 0 };
    },
    async close(): Promise<RuntimeLifecycleCloseSummary> {
      draining = true;
      state = 'closed';
      for (const step of [...steps].reverse()) {
        await step.close?.({ reason: 'test', timeoutMs: 1_000, deadlineAt: Date.now() + 1_000, signal: new AbortController().signal });
      }
      return { reason: 'test', state: 'closed', ok: true, deadlineMs: 1_000, durationMs: 0, steps: [] };
    }
  };
}

describe('runtime initialization', () => {
  it('does not read configuration or attach domains after an already-cancelled startup', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled before startup'));
    await assert.rejects(initializeRuntimeState({
      signal: controller.signal,
      lifecycle: createFakeLifecycle(),
      attachScheduleLifecycle: () => assert.fail('must not attach after cancellation'),
      loadConfig: async () => assert.fail('must not read after cancellation')
    }), error => error === controller.signal.reason);
  });

  it('abandons pending config reads without applying their late results', async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const config = Promise.withResolvers<{ success: boolean; data: unknown }>();
    const lifecycle = createFakeLifecycle();
    const restoring = initializeRuntimeState({
      signal: controller.signal, lifecycle,
      attachScheduleLifecycle: () => ({}),
      loadConfig: async () => { entered.resolve(); return config.promise; },
      applyNotificationConfig: () => assert.fail('late notification must not be applied'),
      registerSchedule: () => assert.fail('late schedule must not be registered'),
      registerAutoUpdate: () => assert.fail('late auto-update must not be registered'),
      readNotificationConfig: () => assert.fail('must not continue to Telegram'),
      runtimeLogger: silentLogger
    });
    await entered.promise;
    controller.abort(new Error('cancelled while reading configuration'));
    await assert.rejects(restoring, error => error === controller.signal.reason);
    config.resolve({ success: true, data: { enabled: true, schedule: { enabled: true } } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(lifecycle.steps, []);
  });

  it('does not attach or start Telegram when connection resolution finishes after cancellation', async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const connection = Promise.withResolvers<{ adbPath: string; address: string }>();
    const restoring = initializeRuntimeState({
      signal: controller.signal, lifecycle: createFakeLifecycle(),
      attachScheduleLifecycle: () => ({}),
      loadConfig: async () => ({ success: true, data: null }),
      readNotificationConfig: () => ({ channels: { telegram: { enabled: true, botToken: 'fixture', chatId: 'fixture' } } }),
      resolveRuntimeConnection: async () => { entered.resolve(); return connection.promise; },
      attachTelegramLifecycle: () => assert.fail('late Telegram must not be attached'),
      startTelegramBot: () => assert.fail('late Telegram must not be started'),
      runtimeLogger: silentLogger
    });
    await entered.promise;
    controller.abort(new Error('cancelled while resolving connection'));
    await assert.rejects(restoring, error => error === controller.signal.reason);
    connection.resolve({ adbPath: '/fixture/adb', address: 'fixture-device' });
    await new Promise(resolve => setImmediate(resolve));
  });

  it('attaches the scheduler stop port before restoring persisted triggers without executing flows', async () => {
    const events: unknown[][] = [];
    const lifecycle = createFakeLifecycle();
    const persisted: Record<string, unknown> = {
      'automation-tasks': {
        taskFlow: [{ id: 'award-1', enabled: true, commandId: 'award' }],
        schedule: { enabled: true, times: ['05:00'] }
      },
      'auto-update': { enabled: true, time: '06:00', updateCore: true }
    };

    await initializeRuntimeState({
      lifecycle,
      attachScheduleLifecycle: target => {
        events.push(['attach', target === lifecycle]);
        target.register({ name: 'scheduled-triggers', close: () => events.push(['close']) });
        return { attached: true };
      },
      loadConfig: async configType => {
        events.push(['load', configType]);
        return { success: true, data: persisted[configType] || null };
      },
      readNotificationConfig: () => ({ channels: {} }),
      registerSchedule: () => {
        events.push(['registerSchedule']);
        return { success: true, message: 'restored schedule' };
      },
      registerAutoUpdate: () => {
        events.push(['registerAutoUpdate']);
        return { success: true, message: 'restored auto update' };
      },
      resolveRuntimeConnection: async () => ({}),
      startTelegramBot: () => events.push(['telegram']),
      runtimeLogger: silentLogger
    });

    assert.deepEqual(events[0], ['attach', true]);
    assert.deepEqual(events.slice(1), [
      ['load', 'notification'],
      ['load', 'automation-tasks'],
      ['load', 'auto-update'],
      ['registerSchedule'],
      ['registerAutoUpdate']
    ]);
    assert.deepEqual(lifecycle.steps.map(step => step.name), ['scheduled-triggers']);
    assert.equal(events.some(([kind]) => kind === 'execute' || kind === 'close'), false);

    await lifecycle.close();
    assert.deepEqual(events.at(-1), ['close']);
    assert.equal(lifecycle.isDraining(), true);
  });

  it('keeps restoring persisted state when the scheduler lifecycle attachment fails', async () => {
    const calls: string[] = [];
    const summary = await initializeRuntimeState({
      lifecycle: createFakeLifecycle(),
      attachScheduleLifecycle: () => {
        throw new Error('lifecycle unavailable');
      },
      loadConfig: async configType => ({
        success: true,
        data: configType === 'automation-tasks'
          ? { taskFlow: [], schedule: { enabled: true, times: ['05:00'] } }
          : null
      }),
      readNotificationConfig: () => ({ channels: {} }),
      registerSchedule: () => {
        calls.push('schedule');
        return { success: true, message: 'restored schedule' };
      },
      registerAutoUpdate: () => {
        calls.push('auto-update');
        return { success: true };
      },
      resolveRuntimeConnection: async () => ({}),
      startTelegramBot: () => calls.push('telegram'),
      runtimeLogger: silentLogger
    });

    assert.deepEqual(calls, ['schedule']);
    assert.equal(summary.schedule.restored, true);
    assert.equal(summary.autoUpdate.restored, false);
    assert.equal(summary.telegram.initialized, false);
  });

  it('restores persisted runtime state before initializing Telegram', async () => {
    const notification = {
      enabled: true,
      channels: {
        telegram: {
          enabled: true,
          botToken: 'persisted-token',
          chatId: 'persisted-chat',
          allowedUserIds: ['42']
        }
      }
    };
    const automation = {
      taskFlow: [{ id: 'award-1', enabled: true, commandId: 'award' }],
      schedule: { enabled: true, times: ['04:30', '12:00'] }
    };
    const autoUpdate = {
      enabled: true,
      time: '03:00',
      updateCore: true,
      updateCli: false
    };
    const persisted: Record<string, unknown> = {
      notification,
      'automation-tasks': automation,
      'auto-update': autoUpdate
    };
    // 捕获注入的端口收到什么；readNotificationConfig 返回应用后的当前配置。
    const calls: { notification?: unknown; schedule?: unknown; autoUpdate?: unknown; telegram?: unknown } = {};

    const summary = await initializeRuntimeState({
      loadConfig: async configType => ({ success: true, data: persisted[configType] }),
      applyNotificationConfig: config => {
        calls.notification = config;
      },
      readNotificationConfig: () => notification,
      registerSchedule: (scheduleId, times, taskFlow) => {
        calls.schedule = { scheduleId, times, taskFlow };
        return { success: true, message: 'restored schedule' };
      },
      registerAutoUpdate: config => {
        calls.autoUpdate = config;
        return { success: true, message: 'restored auto update' };
      },
      resolveRuntimeConnection: async () => ({ adbPath: '/usr/bin/adb', address: 'emulator:5555' }),
      startTelegramBot: config => {
        calls.telegram = config;
      },
      runtimeLogger: silentLogger
    });

    assert.deepEqual(calls.notification, notification);
    assert.deepEqual(calls.schedule, {
      scheduleId: 'default',
      times: ['04:30', '12:00'],
      taskFlow: automation.taskFlow
    });
    assert.deepEqual(calls.autoUpdate, autoUpdate);
    assert.deepEqual(calls.telegram, {
      ...notification.channels.telegram,
      adbPath: '/usr/bin/adb',
      adbAddress: 'emulator:5555'
    });
    assert.deepEqual(summary, {
      notification: { restored: true },
      schedule: { restored: true, message: 'restored schedule' },
      autoUpdate: { restored: true, message: 'restored auto update' },
      telegram: { initialized: true }
    });
  });

  it('isolates restore failures so other persisted jobs still start', async () => {
    const calls: string[] = [];
    const summary = await initializeRuntimeState({
      loadConfig: async configType => {
        if (configType === 'notification') throw new Error('notification storage unavailable');
        if (configType === 'automation-tasks') {
          return {
            success: true,
            data: { taskFlow: [], schedule: { enabled: true, times: ['05:00'] } }
          };
        }
        return {
          success: true,
          data: { enabled: true, time: '06:00', updateCore: true, updateCli: true }
        };
      },
      applyNotificationConfig: () => calls.push('notification'),
      readNotificationConfig: () => ({ channels: {} }),
      registerSchedule: () => {
        calls.push('schedule');
        throw new Error('invalid schedule');
      },
      registerAutoUpdate: () => {
        calls.push('auto-update');
        return { success: true, message: 'auto update restored' };
      },
      resolveRuntimeConnection: async () => {
        calls.push('connection');
        return {};
      },
      startTelegramBot: () => calls.push('telegram'),
      runtimeLogger: silentLogger
    });

    assert.deepEqual(calls, ['schedule', 'auto-update']);
    assert.equal(summary.notification.restored, false);
    assert.equal(summary.schedule.restored, false);
    assert.equal(summary.schedule.error, 'invalid schedule');
    assert.equal(summary.autoUpdate.restored, true);
    assert.equal(summary.telegram.initialized, false);
  });

  it('initializes Telegram from the current config when no persisted notification exists', async () => {
    let telegramConfig: TelegramRuntimeConfig | null = null;
    const currentTelegram = {
      enabled: true,
      botToken: 'environment-token',
      chatId: 'environment-chat'
    };

    const summary = await initializeRuntimeState({
      loadConfig: async () => ({ success: true, data: null }),
      applyNotificationConfig: () => assert.fail('no persisted notification should be applied'),
      readNotificationConfig: () => ({ channels: { telegram: currentTelegram } }),
      registerSchedule: () => assert.fail('no schedule should be registered'),
      registerAutoUpdate: () => assert.fail('no auto update should be registered'),
      resolveRuntimeConnection: async () => ({ adbPath: '/env/adb', address: 'env-device:5555' }),
      startTelegramBot: config => {
        telegramConfig = config;
      },
      runtimeLogger: silentLogger
    });

    assert.deepEqual(telegramConfig, {
      ...currentTelegram,
      adbPath: '/env/adb',
      adbAddress: 'env-device:5555'
    });
    assert.equal(summary.notification.restored, false);
    assert.equal(summary.telegram.initialized, true);
  });

  it('attaches the Telegram stop port before starting the enabled bot', async () => {
    const events: unknown[][] = [];
    const lifecycle = createFakeLifecycle();

    const summary = await initializeRuntimeState({
      lifecycle,
      attachScheduleLifecycle: () => ({ attached: false, duplicate: false }),
      loadConfig: async () => ({ success: true, data: null }),
      readNotificationConfig: () => ({
        channels: { telegram: { enabled: true, botToken: 'stop-token', chatId: 'stop-chat' } }
      }),
      registerSchedule: () => assert.fail('no schedule should be registered'),
      registerAutoUpdate: () => assert.fail('no auto update should be registered'),
      resolveRuntimeConnection: async () => ({ adbPath: '/adb', address: 'device:5555' }),
      attachTelegramLifecycle: target => {
        events.push(['attach', target === lifecycle]);
        target.register({ name: 'telegram-bot', close: () => events.push(['close']) });
        return { attached: true, duplicate: false };
      },
      startTelegramBot: config => events.push(['start', config.botToken]),
      runtimeLogger: silentLogger
    });

    assert.deepEqual(events, [['attach', true], ['start', 'stop-token']]);
    assert.equal(summary.telegram.initialized, true);
    assert.deepEqual(lifecycle.steps.map(step => step.name), ['telegram-bot']);

    await lifecycle.close();
    assert.deepEqual(events.at(-1), ['close']);
  });

  it('does not start Telegram when its stop port cannot be attached', async () => {
    const started: string[] = [];

    const summary = await initializeRuntimeState({
      lifecycle: createFakeLifecycle(),
      attachScheduleLifecycle: () => ({ attached: false, duplicate: false }),
      loadConfig: async () => ({ success: true, data: null }),
      readNotificationConfig: () => ({
        channels: { telegram: { enabled: true, botToken: 'stop-token', chatId: 'stop-chat' } }
      }),
      registerSchedule: () => assert.fail('no schedule should be registered'),
      registerAutoUpdate: () => assert.fail('no auto update should be registered'),
      resolveRuntimeConnection: async () => ({}),
      attachTelegramLifecycle: () => {
        throw new Error('lifecycle unavailable');
      },
      startTelegramBot: () => started.push('telegram'),
      runtimeLogger: silentLogger
    });

    assert.deepEqual(started, []);
    assert.equal(summary.telegram.initialized, false);
    assert.equal(summary.telegram.error, 'lifecycle unavailable');
  });
});
