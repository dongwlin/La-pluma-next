import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { initializeRuntimeState } from '../runtimeInitializationService.js';

const silentLogger = {
  info() {},
  warn() {},
  error() {}
};

function createFakeLifecycle() {
  let draining = false;
  const steps = [];
  return {
    steps,
    register(step) {
      steps.push(step);
    },
    isDraining: () => draining,
    async close() {
      draining = true;
      for (const step of [...steps].reverse()) {
        await step.close?.();
      }
      return { ok: true };
    }
  };
}

describe('runtime initialization', () => {
  it('attaches the scheduler stop port before restoring persisted triggers without executing flows', async () => {
    const events = [];
    const lifecycle = createFakeLifecycle();
    const persisted = {
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
    const calls = [];
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
    const persisted = {
      notification,
      'automation-tasks': automation,
      'auto-update': autoUpdate
    };
    const calls = {};
    let activeNotification = null;

    const summary = await initializeRuntimeState({
      loadConfig: async configType => ({ success: true, data: persisted[configType] }),
      applyNotificationConfig: config => {
        calls.notification = config;
        activeNotification = config;
      },
      readNotificationConfig: () => activeNotification,
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
    const calls = [];
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
    let telegramConfig = null;
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
    const events = [];
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
    const started = [];

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
