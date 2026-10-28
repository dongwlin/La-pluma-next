import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import express from 'express';
import agentRouter from '../agent.ts';
import { createAgentNotificationRoutes } from '../agentNotificationRoutes.ts';
import type { AgentNotificationRouteDependencies } from '../agentNotificationRoutes.ts';
import { createLaPlumaApp } from '../../server.ts';
import {
  parseChannelTestBody,
  parseNotificationConfigBody,
  parseSendNotificationBody,
  persistAndApplyNotificationConfig
} from '../notificationDto.ts';
import type {
  NotificationChannelTestPayload,
  NotificationConfigPayload
} from '../notificationDto.ts';
import { setConfigStorageDirForTests } from '../../services/configStorageService.ts';
import { getNotificationConfig, setNotificationConfig } from '../../services/notificationService.ts';
import type {
  NotificationConfig,
  NotificationMessage
} from '../../services/notificationService.ts';
import {
  agentError,
  apiErrorHandler,
  errorResponse,
  successResponse
} from '../../utils/apiHelper.ts';
import type { ApiErrorResponse, ApiSuccessResponse } from '../../utils/apiHelper.ts';
import { loggerManager } from '../../utils/logger.ts';

// 通知 HTTP 适配已从 agent.ts 拆到独立 router：这里按 agent.ts 实际挂载
// 关系验证入口存在，并通过真实 HTTP 验证鉴权、body 校验与统一错误出口。
// 发送/测试路径只使用注入的假发送器或会在发起网络前失败的缺省配置；
// 涉及发送的用例同时安装运行时出站守卫，证明回归不会发送真实通知消息。
// 生产路由已类型化，本文件同步转为 TS：body 收窄、配置保存与应用结果、
// 敏感字段/出站端口不进入测试与发送响应的断言与实现共用同一 DTO。
const savedConfig = getNotificationConfig();
const tempDirs: string[] = [];
const servers: Server[] = [];

// 真实 HTTP 用例会触发服务日志；控制台输出关闭，避免门禁输出被诊断行淹没。
for (const loggerName of ['Api', 'Notification', 'ConfigStorage']) {
  loggerManager.getLogger(loggerName).enableConsole = false;
}

/**
 * 运行时出站守卫：只允许用例自身的 127.0.0.1 回环请求，其他地址记录后失败。
 * 经 t.mock.method 安装并在用例结束恢复，不在源码层改写全局 fetch 声明。
 */
function guardOutboundFetch(t: TestContext): { external: string[] } {
  const realFetch = globalThis.fetch;
  const external: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.hostname !== '127.0.0.1') {
      external.push(url.href);
      throw new Error(`unexpected outbound request: ${url.host}`);
    }
    return realFetch(input, init);
  });
  return { external };
}

interface MountedRouteLayer {
  route?: { path: string; methods?: Record<string, boolean> };
  handle?: MountedRouteLayer;
}

function collectMountedRoutes(routerInstance: unknown, routes: string[] = []): string[] {
  const stack = (routerInstance as { stack?: MountedRouteLayer[] }).stack ?? [];
  for (const layer of stack) {
    if (layer.route) {
      for (const [method, enabled] of Object.entries(layer.route.methods ?? {})) {
        if (enabled) routes.push(`${method.toUpperCase()} ${layer.route.path}`);
      }
      continue;
    }
    if (layer.handle) collectMountedRoutes(layer.handle, routes);
  }
  return routes;
}

interface NotificationRouteEntry {
  method: string;
  path: string;
}

const NOTIFICATION_ROUTES: NotificationRouteEntry[] = [
  { method: 'GET', path: '/notifications/config' },
  { method: 'POST', path: '/notifications/config' },
  { method: 'POST', path: '/actions/test-notification-channel' },
  { method: 'POST', path: '/actions/send-notification' }
];

function isApiSuccess(value: unknown): value is ApiSuccessResponse<unknown> {
  return typeof value === 'object'
    && value !== null
    && (value as { success?: unknown }).success === true;
}

function isApiError(value: unknown): value is ApiErrorResponse {
  return typeof value === 'object'
    && value !== null
    && (value as { success?: unknown }).success === false;
}

/** fetch 的 JSON 载荷是 unknown；先确认统一信封，再按端点声明的 DTO 读取。 */
async function readSuccess<T>(response: Response): Promise<ApiSuccessResponse<T>> {
  const body: unknown = await response.json();
  assert.ok(isApiSuccess(body));
  return body as ApiSuccessResponse<T>;
}

async function readError(response: Response): Promise<ApiErrorResponse> {
  const body: unknown = await response.json();
  assert.ok(isApiError(body));
  return body;
}

function isAgentErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === code;
}

async function listen(app: ReturnType<typeof createLaPlumaApp>): Promise<number> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

function agentUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port}/api/agent${path}`;
}

function jsonRequest(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

async function useTempConfigStorage(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'la-pluma-notification-http-'));
  tempDirs.push(dir);
  setConfigStorageDirForTests(dir);
  return dir;
}

/**
 * 最小挂载：与 agent.ts 一样把通知 router 挂在 /api/agent 下，并复用生产
 * 统一错误出口。鉴权由 createLaPlumaApp 的真实用例单独覆盖，这里专注
 * 注入发送器后的响应与失败语义。
 */
function createNotificationApp(notification: AgentNotificationRouteDependencies = {}) {
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
    assert.ok(server);
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    assert.ok(dir);
    await rm(dir, { recursive: true, force: true });
  }
});

describe('notification request narrowing', () => {
  it('keeps the raw config body for storage validation', () => {
    const payload = { enabled: true, channels: { telegram: { enabled: true } } };
    // 对象请求体原样交给配置存储，扩展字段与白名单校验都不在路由层。
    assert.equal(parseNotificationConfigBody(payload), payload);
    for (const body of [undefined, null, 0, '', false]) {
      assert.deepEqual(parseNotificationConfigBody(body), {});
    }
    // 真值非对象保持原值，继续由存储域返回既有 400 AGENT_CONFIG_DATA_INVALID。
    assert.deepEqual(parseNotificationConfigBody([1, 2]), [1, 2]);
    assert.equal(parseNotificationConfigBody('text'), 'text');
  });

  it('narrows the channel test body and rejects invalid shapes before the service', () => {
    assert.deepEqual(parseChannelTestBody({ channel: 'telegram', config: { botToken: 'fixture-token' } }), {
      channel: 'telegram',
      config: { botToken: 'fixture-token' }
    });
    assert.deepEqual(parseChannelTestBody({ channel: 'telegram' }), { channel: 'telegram', config: null });
    assert.deepEqual(parseChannelTestBody({ channel: 'telegram', config: null }), { channel: 'telegram', config: null });
    // 非字符串真值按文本收窄；渠道注册表以字符串为键，未知渠道仍走既有失败路径。
    assert.equal(parseChannelTestBody({ channel: 42 }).channel, '42');

    for (const body of [undefined, null, {}, { channel: '' }, { channel: 0 }, 'telegram', [1, 2]]) {
      assert.throws(
        () => parseChannelTestBody(body),
        (error: unknown) => isAgentErrorCode(error, 'AGENT_VALIDATION_CHANNEL_REQUIRED'),
        `channel must be required for ${JSON.stringify(body)}`
      );
    }
    for (const config of [['not-an-object'], 1, 'text', false]) {
      assert.throws(
        () => parseChannelTestBody({ channel: 'telegram', config }),
        (error: unknown) => isAgentErrorCode(error, 'AGENT_VALIDATION_NOTIFICATION_CONFIG_INVALID')
      );
    }
  });

  it('keeps send defaults and narrows message fields from unknown', () => {
    assert.deepEqual(parseSendNotificationBody(undefined), {
      channel: null,
      message: { title: '测试通知', content: '这是一条测试通知', level: 'info', data: undefined }
    });
    assert.deepEqual(parseSendNotificationBody({
      channel: 'telegram',
      title: '完成',
      content: '任务结束',
      level: 'warning',
      data: { runId: 'fixture-run' }
    }), {
      channel: 'telegram',
      message: {
        title: '完成',
        content: '任务结束',
        level: 'warning',
        data: { runId: 'fixture-run' }
      }
    });
    // 非字符串标题按文本输出（与旧实现的模板插值一致）；非字符串级别与
    // 非对象 data 不再穿透到渠道适配器。
    assert.deepEqual(parseSendNotificationBody({ title: 5, content: 0, level: null, data: [1, 2] }), {
      channel: null,
      message: { title: '5', content: '这是一条测试通知', level: 'info', data: undefined }
    });
    assert.equal(parseSendNotificationBody({ channel: 7 }).channel, '7');
  });

  it('keeps persistence and runtime application as separate outcomes', async () => {
    const applied: string[] = [];
    const appliedOutcome = await persistAndApplyNotificationConfig({
      save: async () => successResponse(null, '配置保存成功'),
      apply: () => { applied.push('applied'); }
    });
    assert.deepEqual(appliedOutcome, { persisted: true, applied: true });
    assert.deepEqual(applied, ['applied']);

    const storageFailure = errorResponse(
      agentError('AGENT_CONFIG_DATA_INVALID', '配置数据必须是 JSON 对象', { statusCode: 400 }),
      '保存配置失败'
    );
    const failedPersist = await persistAndApplyNotificationConfig({
      save: async () => storageFailure,
      apply: () => { throw new Error('persistence failure must not apply'); }
    });
    if (failedPersist.persisted) {
      assert.fail('persistence failure must be reported separately');
    }
    assert.equal(failedPersist.storage, storageFailure);
    assert.deepEqual(applied, ['applied']);

    const applyError = new Error('运行时配置应用失败');
    const failedApply = await persistAndApplyNotificationConfig({
      save: async () => successResponse(null, '配置保存成功'),
      apply: () => { throw applyError; }
    });
    if (!failedApply.persisted || failedApply.applied) {
      assert.fail('runtime application failure must stay identifiable');
    }
    assert.equal(failedApply.error, applyError);
  });
});

describe('notification route exposure', () => {
  it('mounts every notification entry exactly once through the agent router', () => {
    const mounted = collectMountedRoutes(agentRouter);

    for (const entry of NOTIFICATION_ROUTES) {
      const route = `${entry.method} ${entry.path}`;
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
      const response = await fetch(agentUrl(port, entry.path), { method: entry.method });
      assert.equal(response.status, 401, `${entry.method} ${entry.path} must stay behind auth`);
      assert.equal((await readError(response)).error.code, 'AGENT_AUTH_REQUIRED');
    }
  });

  it('keeps config read and save contracts, including persisted extension fields', async t => {
    const outbound = guardOutboundFetch(t);
    const storageDir = await useTempConfigStorage();
    const app = createLaPlumaApp({ env: {} });
    const port = await listen(app);

    const initial = await fetch(agentUrl(port, '/notifications/config'));
    assert.equal(initial.status, 200);
    const initialBody = await readSuccess<NotificationConfigPayload>(initial);
    assert.equal(typeof initialBody.data, 'object');
    assert.equal(typeof initialBody.data.channels.telegram, 'object');

    const config = {
      enabled: false,
      channels: { telegram: { enabled: false, botToken: '', chatId: '' } },
      extension: { nested: { keep: true } }
    };
    const saved = await fetch(agentUrl(port, '/notifications/config'), jsonRequest(config));
    assert.equal(saved.status, 200);
    assert.equal((await readSuccess<null>(saved)).message, '通知配置已保存');

    const persisted: unknown = JSON.parse(await readFile(join(storageDir, 'notification.json'), 'utf8'));
    assert.deepEqual(persisted, config);

    const current = await fetch(agentUrl(port, '/notifications/config'));
    const currentBody = await readSuccess<NotificationConfig>(current);
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
    const body = await readError(response);
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
    const sentBody = await readSuccess<{ success: boolean; message: string }>(sent);
    assert.equal(sentBody.success, true);
    assert.equal(sentBody.message, '通知已发送');
    assert.equal(sentBody.data.success, true);
    assert.equal(sentBody.data.message, '通知功能未启用');
    assert.equal(outbound.external.length, 0);

    const missingChannel = await fetch(agentUrl(port, '/actions/test-notification-channel'), jsonRequest({}));
    assert.equal(missingChannel.status, 400);
    assert.equal((await readError(missingChannel)).error.code, 'AGENT_VALIDATION_CHANNEL_REQUIRED');

    const invalidConfig = await fetch(agentUrl(port, '/actions/test-notification-channel'), jsonRequest({
      channel: 'telegram',
      config: ['not-an-object']
    }));
    assert.equal(invalidConfig.status, 400);
    assert.equal((await readError(invalidConfig)).error.code, 'AGENT_VALIDATION_NOTIFICATION_CONFIG_INVALID');

    // 缺省 telegram 配置缺少凭据：渠道测试在发起网络前失败，仍返回既有业务错误
    const missingCredentials = await fetch(agentUrl(port, '/actions/test-notification-channel'), jsonRequest({
      channel: 'telegram'
    }));
    assert.equal(missingCredentials.status, 400);
    const missingBody = await readError(missingCredentials);
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
    const body = await readError(response);
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
    const calls = {
      applied: [] as unknown[],
      tested: [] as Array<{ channel: string; config: unknown }>,
      sentToAll: [] as NotificationMessage[],
      sentToOne: [] as Array<{ channel: string; payload: NotificationMessage }>
    };
    const injectedConfig: NotificationConfig = {
      enabled: true,
      channels: { telegram: { enabled: true, botToken: 'fixture-bot-token', chatId: 'fixture-chat' } }
    };
    const app = createNotificationApp({
      getNotificationConfig: () => injectedConfig,
      setNotificationConfig: config => { calls.applied.push(config); },
      testNotificationChannel: async (channel, config) => {
        calls.tested.push({ channel, config });
        return { success: true, message: '注入测试成功' };
      },
      sendNotification: async payload => {
        calls.sentToAll.push(payload);
        return { success: true, message: '注入群发完成', results: [{ channel: 'telegram', success: true }] };
      },
      sendToChannel: async (channel, payload) => {
        calls.sentToOne.push({ channel, payload });
        return { success: true, channel };
      }
    });
    const port = await listen(app);

    // 配置读取沿用既有契约：设置页需要完整渠道配置（含凭据）才能原样保存。
    const read = await fetch(agentUrl(port, '/notifications/config'));
    const readBody = await readSuccess<NotificationConfig>(read);
    assert.deepEqual(readBody.data, injectedConfig);

    await useTempConfigStorage();
    const config = { enabled: false, channels: { telegram: { enabled: false } } };
    const save = await fetch(agentUrl(port, '/notifications/config'), jsonRequest(config));
    assert.equal((await readSuccess<null>(save)).message, '通知配置已保存');
    assert.deepEqual(calls.applied, [config]);

    const tested = await fetch(agentUrl(port, '/actions/test-notification-channel'), jsonRequest({
      channel: 'telegram',
      config: { botToken: 'fixture-test-token' }
    }));
    const testedBody = await readSuccess<NotificationChannelTestPayload>(tested);
    assert.equal(testedBody.data.channel, 'telegram');
    assert.equal(testedBody.message, '注入测试成功');
    assert.deepEqual(calls.tested, [{ channel: 'telegram', config: { botToken: 'fixture-test-token' } }]);

    const sentToAll = await fetch(agentUrl(port, '/actions/send-notification'), jsonRequest({
      title: '完成',
      content: '任务结束',
      level: 'warning',
      data: { runId: 'fixture-run' }
    }));
    const sentToAllBody = await readSuccess<{ success: boolean; message: string; results: unknown[] }>(sentToAll);
    assert.equal(sentToAllBody.message, '通知已发送');
    assert.deepEqual(sentToAllBody.data, {
      success: true,
      message: '注入群发完成',
      results: [{ channel: 'telegram', success: true }]
    });
    assert.deepEqual(calls.sentToAll, [{
      title: '完成',
      content: '任务结束',
      level: 'warning',
      data: { runId: 'fixture-run' }
    }]);

    const sentToOne = await fetch(agentUrl(port, '/actions/send-notification'), jsonRequest({
      channel: 'telegram'
    }));
    const sentToOneBody = await readSuccess<{ success: boolean; channel: string }>(sentToOne);
    assert.equal(sentToOneBody.message, '通知已发送到指定渠道');
    assert.deepEqual(sentToOneBody.data, { success: true, channel: 'telegram' });
    assert.deepEqual(calls.sentToOne, [{
      channel: 'telegram',
      payload: { title: '测试通知', content: '这是一条测试通知', level: 'info', data: undefined }
    }]);

    // 测试/发送响应只回显渠道名或发送结果：渠道配置、凭据与出站端口都不外露。
    const publicResponses = JSON.stringify([testedBody, sentToAllBody, sentToOneBody]);
    assert.ok(!/botToken|chatId|outboundHttp|fixture-bot-token|fixture-test-token/.test(publicResponses));

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
    const body = await readError(response);
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
    const body = await readError(response);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'AGENT_INTERNAL_ERROR');
    assert.equal(body.message, '服务器内部错误');
    assert.ok(!JSON.stringify(body).includes('通知配置已保存'));

    // 部分失败如实存在：配置已落盘，但请求不能伪装成全成功
    const persisted: unknown = JSON.parse(await readFile(join(storageDir, 'notification.json'), 'utf8'));
    assert.deepEqual(persisted, config);
  });

  it('does not apply runtime config when persistence fails', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'la-pluma-notification-broken-'));
    tempDirs.push(baseDir);
    const notADirectory = join(baseDir, 'not-a-directory');
    await writeFile(notADirectory, 'occupied');
    setConfigStorageDirForTests(notADirectory);

    const applied: unknown[] = [];
    const app = createNotificationApp({
      setNotificationConfig: config => { applied.push(config); }
    });
    const port = await listen(app);

    const response = await fetch(agentUrl(port, '/notifications/config'), jsonRequest({ enabled: false }));

    assert.equal(response.status, 500);
    const body = await readError(response);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'AGENT_NOTIFICATION_CONFIG_SAVE_FAILED');
    assert.deepEqual(applied, []);
  });
});
