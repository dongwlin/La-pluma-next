import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import express from 'express';
import agentRouter from '../agent.js';
import { createAgentNotificationRoutes } from '../agentNotificationRoutes.js';
import { createLaPlumaApp } from '../../server.js';
import { setConfigStorageDirForTests } from '../../services/configStorageService.ts';
import { getNotificationConfig, setNotificationConfig } from '../../services/notificationService.js';
import { apiErrorHandler } from '../../utils/apiHelper.ts';
import { loggerManager } from '../../utils/logger.ts';

// 通知 HTTP 适配已从 agent.js 拆到独立 router：这里按 agent.js 实际挂载
// 关系验证入口存在，并通过真实 HTTP 验证鉴权、body 校验与统一错误出口。
// 发送/测试路径只使用注入的假发送器或会在发起网络前失败的缺省配置；
// 涉及发送的用例同时安装运行时出站守卫，证明回归不会发送真实通知消息。
const savedConfig = getNotificationConfig();
const tempDirs = [];
const servers = [];

// 真实 HTTP 用例会触发服务日志；控制台输出关闭，避免门禁输出被诊断行淹没。
for (const loggerName of ['Api', 'Notification', 'ConfigStorage']) {
  loggerManager.getLogger(loggerName).enableConsole = false;
}

/**
 * 运行时出站守卫：只允许用例自身的 127.0.0.1 回环请求，其他地址记录后失败。
 * 经 t.mock.method 安装并在用例结束恢复，不在源码层改写全局 fetch 声明。
 */
function guardOutboundFetch(t) {
  const realFetch = globalThis.fetch;
  const external = [];
  const mock = t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname !== '127.0.0.1') {
      external.push(url.href);
      throw new Error(`unexpected outbound request: ${url.host}`);
    }
    return realFetch(input, init);
  });
  return { mock, external };
}

function collectMountedRoutes(routerInstance, routes = []) {
  for (const layer of routerInstance.stack) {
    if (layer.route) {
      for (const [method, enabled] of Object.entries(layer.route.methods ?? {})) {
        if (enabled) routes.push(`${method.toUpperCase()} ${layer.route.path}`);
      }
      continue;
    }
    if (layer.handle?.stack) collectMountedRoutes(layer.handle, routes);
  }
  return routes;
}

const NOTIFICATION_ROUTES = [
  'GET /notifications/config',
  'POST /notifications/config',
  'POST /actions/test-notification-channel',
  'POST /actions/send-notification'
];

async function listen(app) {
  const server = createServer(app);
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function agentUrl(port, path) {
  return `http://127.0.0.1:${port}/api/agent${path}`;
}

function jsonRequest(body) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

async function useTempConfigStorage() {
  const dir = await mkdtemp(join(tmpdir(), 'la-pluma-notification-http-'));
  tempDirs.push(dir);
  setConfigStorageDirForTests(dir);
  return dir;
}

/**
 * 最小挂载：与 agent.js 一样把通知 router 挂在 /api/agent 下，并复用生产
 * 统一错误出口。鉴权由 createLaPlumaApp 的真实用例单独覆盖，这里专注
 * 注入发送器后的响应与失败语义。
 */
function createNotificationApp(notification) {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', createAgentNotificationRoutes(notification));
  app.use('/api', apiErrorHandler);
  return app;
}

afterEach(async () => {
  setConfigStorageDirForTests(null);
  setNotificationConfig(savedConfig);
  while (servers.length) {
    const server = servers.pop();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
  while (tempDirs.length) await rm(tempDirs.pop(), { recursive: true, force: true });
});

describe('notification route exposure', () => {
  it('mounts every notification entry exactly once through the agent router', () => {
    const mounted = collectMountedRoutes(agentRouter);

    for (const route of NOTIFICATION_ROUTES) {
      assert.equal(
        mounted.filter(candidate => candidate === route).length,
        1,
        `expected exactly one mounted ${route}`
      );
    }
  });
});

describe('notification routes over real HTTP', () => {
  it('requires the API token on every notification entry', async () => {
    const app = createLaPlumaApp({
      env: { LA_PLUMA_TOKEN: 'api-secret' },
      loginRateLimit: { maxAuthFailures: 100 }
    });
    const port = await listen(app);

    for (const entry of NOTIFICATION_ROUTES) {
      const [method, path] = entry.split(' ');
      const response = await fetch(agentUrl(port, path), { method });
      assert.equal(response.status, 401, `${entry} must stay behind auth`);
      assert.equal((await response.json()).error.code, 'AGENT_AUTH_REQUIRED');
    }
  });

  it('keeps config read and save contracts, including persisted extension fields', async t => {
    const outbound = guardOutboundFetch(t);
    const storageDir = await useTempConfigStorage();
    const app = createLaPlumaApp({ env: {} });
    const port = await listen(app);

    const initial = await fetch(agentUrl(port, '/notifications/config'));
    assert.equal(initial.status, 200);
    const initialBody = await initial.json();
    assert.equal(initialBody.success, true);
    assert.equal(typeof initialBody.data, 'object');
    assert.equal(typeof initialBody.data.channels.telegram, 'object');

    const config = {
      enabled: false,
      channels: { telegram: { enabled: false, botToken: '', chatId: '' } },
      extension: { nested: { keep: true } }
    };
    const saved = await fetch(agentUrl(port, '/notifications/config'), jsonRequest(config));
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).message, '通知配置已保存');

    const persisted = JSON.parse(await readFile(join(storageDir, 'notification.json'), 'utf8'));
    assert.deepEqual(persisted, config);

    const current = await fetch(agentUrl(port, '/notifications/config'));
    const currentBody = await current.json();
    assert.deepEqual(currentBody.data.extension, { nested: { keep: true } });
    assert.equal(currentBody.data.enabled, false);
    assert.equal(outbound.external.length, 0, 'config routes must not reach notification providers');
  });

  it('rejects non-object config bodies before persisting or applying', async () => {
    const storageDir = await useTempConfigStorage();
    const app = createLaPlumaApp({ env: {} });
    const port = await listen(app);

    const response = await fetch(agentUrl(port, '/notifications/config'), jsonRequest([1, 2]));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'AGENT_CONFIG_DATA_INVALID');
    assert.deepEqual(await readdir(storageDir), []);
  });

  it('keeps channel selection and default payload semantics for send requests', async t => {
    const outbound = guardOutboundFetch(t);
    const app = createLaPlumaApp({ env: {} });
    const port = await listen(app);

    // 缺省通知配置未启用：发送入口返回既有“未启用”结果，不建立任何出站请求
    const sent = await fetch(agentUrl(port, '/actions/send-notification'), jsonRequest({}));
    assert.equal(sent.status, 200);
    const sentBody = await sent.json();
    assert.equal(sentBody.success, true);
    assert.equal(sentBody.message, '通知已发送');
    assert.equal(sentBody.data.success, true);
    assert.equal(sentBody.data.message, '通知功能未启用');
    assert.equal(outbound.external.length, 0);

    const missingChannel = await fetch(agentUrl(port, '/actions/test-notification-channel'), jsonRequest({}));
    assert.equal(missingChannel.status, 400);
    assert.equal((await missingChannel.json()).error.code, 'AGENT_VALIDATION_CHANNEL_REQUIRED');

    const invalidConfig = await fetch(agentUrl(port, '/actions/test-notification-channel'), jsonRequest({
      channel: 'telegram',
      config: ['not-an-object']
    }));
    assert.equal(invalidConfig.status, 400);
    assert.equal((await invalidConfig.json()).error.code, 'AGENT_VALIDATION_NOTIFICATION_CONFIG_INVALID');

    // 缺省 telegram 配置缺少凭据：渠道测试在发起网络前失败，仍返回既有业务错误
    const missingCredentials = await fetch(agentUrl(port, '/actions/test-notification-channel'), jsonRequest({
      channel: 'telegram'
    }));
    assert.equal(missingCredentials.status, 400);
    const missingBody = await missingCredentials.json();
    assert.equal(missingBody.error.code, 'AGENT_NOTIFICATION_TEST_FAILED');
    assert.deepEqual(missingBody.error.details, { channel: 'telegram' });
    assert.match(missingBody.message, /Telegram 配置不完整/);
    assert.equal(outbound.external.length, 0);
  });

  it('routes unexpected provider errors through the unified error exit', async t => {
    const outbound = guardOutboundFetch(t);
    const app = createLaPlumaApp({ env: {} });
    const port = await listen(app);

    const response = await fetch(agentUrl(port, '/actions/test-notification-channel'), jsonRequest({
      channel: 'not-a-channel'
    }));

    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'AGENT_INTERNAL_ERROR');
    assert.equal(body.message, '服务器内部错误');
    assert.ok(!JSON.stringify(body).includes('未知的通知渠道'));
    assert.equal(outbound.external.length, 0);
  });
});

describe('notification routes with injected senders', () => {
  it('answers config, test and send requests without touching real channels', async t => {
    const outbound = guardOutboundFetch(t);
    const calls = { applied: [], tested: [], sentToAll: [], sentToOne: [] };
    const injectedConfig = { enabled: true, channels: { telegram: { enabled: true, botToken: 'fixture' } } };
    const app = createNotificationApp({
      getNotificationConfig: () => injectedConfig,
      setNotificationConfig: config => calls.applied.push(config),
      testNotificationChannel: async (channel, config) => {
        calls.tested.push({ channel, config });
        return { success: true, message: '注入测试成功' };
      },
      sendNotification: async payload => {
        calls.sentToAll.push(payload);
        return { success: true, results: [{ channel: 'telegram', success: true }] };
      },
      sendToChannel: async (channel, payload) => {
        calls.sentToOne.push({ channel, payload });
        return { success: true, channel };
      }
    });
    const port = await listen(app);

    const read = await fetch(agentUrl(port, '/notifications/config'));
    assert.deepEqual((await read.json()).data, injectedConfig);

    await useTempConfigStorage();
    const config = { enabled: false, channels: { telegram: { enabled: false } } };
    const save = await fetch(agentUrl(port, '/notifications/config'), jsonRequest(config));
    assert.equal((await save.json()).message, '通知配置已保存');
    assert.deepEqual(calls.applied, [config]);

    const tested = await fetch(agentUrl(port, '/actions/test-notification-channel'), jsonRequest({
      channel: 'telegram',
      config: { botToken: 'fixture' }
    }));
    const testedBody = await tested.json();
    assert.equal(testedBody.data.channel, 'telegram');
    assert.equal(testedBody.message, '注入测试成功');
    assert.deepEqual(calls.tested, [{ channel: 'telegram', config: { botToken: 'fixture' } }]);

    const sentToAll = await fetch(agentUrl(port, '/actions/send-notification'), jsonRequest({
      title: '完成',
      content: '任务结束',
      level: 'warning',
      data: { runId: 'fixture-run' }
    }));
    const sentToAllBody = await sentToAll.json();
    assert.equal(sentToAllBody.message, '通知已发送');
    assert.deepEqual(sentToAllBody.data, { success: true, results: [{ channel: 'telegram', success: true }] });
    assert.deepEqual(calls.sentToAll, [{
      title: '完成',
      content: '任务结束',
      level: 'warning',
      data: { runId: 'fixture-run' }
    }]);

    const sentToOne = await fetch(agentUrl(port, '/actions/send-notification'), jsonRequest({
      channel: 'telegram'
    }));
    const sentToOneBody = await sentToOne.json();
    assert.equal(sentToOneBody.message, '通知已发送到指定渠道');
    assert.deepEqual(sentToOneBody.data, { success: true, channel: 'telegram' });
    assert.deepEqual(calls.sentToOne, [{
      channel: 'telegram',
      payload: { title: '测试通知', content: '这是一条测试通知', level: 'info', data: undefined }
    }]);

    assert.equal(calls.tested.length, 1);
    assert.equal(calls.sentToAll.length, 1);
    assert.equal(outbound.external.length, 0, 'injected senders must not reach real providers');
  });

  it('keeps the business failure envelope for an injected failing channel test', async () => {
    const app = createNotificationApp({
      testNotificationChannel: async () => ({ success: false, message: '注入渠道不可用' })
    });
    const port = await listen(app);

    const response = await fetch(agentUrl(port, '/actions/test-notification-channel'), jsonRequest({
      channel: 'telegram'
    }));

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'AGENT_NOTIFICATION_TEST_FAILED');
    assert.equal(body.message, '注入渠道不可用');
    assert.deepEqual(body.error.details, { channel: 'telegram' });
    assert.equal(body.error.retryable, false);
  });
});

describe('notification config persistence and runtime application', () => {
  it('does not report success when persistence succeeds but runtime application fails', async () => {
    const storageDir = await useTempConfigStorage();
    const app = createNotificationApp({
      setNotificationConfig: () => {
        throw new Error('运行时配置应用失败');
      }
    });
    const port = await listen(app);

    const config = { enabled: true, channels: { telegram: { enabled: true, botToken: 'fixture', chatId: 'fixture' } } };
    const response = await fetch(agentUrl(port, '/notifications/config'), jsonRequest(config));

    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'AGENT_INTERNAL_ERROR');
    assert.equal(body.message, '服务器内部错误');
    assert.ok(!JSON.stringify(body).includes('通知配置已保存'));

    // 部分失败如实存在：配置已落盘，但请求不能伪装成全成功
    const persisted = JSON.parse(await readFile(join(storageDir, 'notification.json'), 'utf8'));
    assert.deepEqual(persisted, config);
  });

  it('does not apply runtime config when persistence fails', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'la-pluma-notification-broken-'));
    tempDirs.push(baseDir);
    const notADirectory = join(baseDir, 'not-a-directory');
    await writeFile(notADirectory, 'occupied');
    setConfigStorageDirForTests(notADirectory);

    const applied = [];
    const app = createNotificationApp({
      setNotificationConfig: config => applied.push(config)
    });
    const port = await listen(app);

    const response = await fetch(agentUrl(port, '/notifications/config'), jsonRequest({ enabled: false }));

    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'AGENT_NOTIFICATION_CONFIG_SAVE_FAILED');
    assert.deepEqual(applied, []);
  });
});
