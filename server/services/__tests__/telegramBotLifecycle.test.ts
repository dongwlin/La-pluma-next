import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  TELEGRAM_LONG_POLL_SECONDS,
  TELEGRAM_LONG_POLL_TIMEOUT_MS,
  createTelegramBotService,
  parseTelegramCommand,
  resolveTelegramCommandRequest
} from '../telegramBotService.ts';
import type {
  TelegramBotConfig,
  TelegramBotService,
  TelegramBotServiceOverrides,
  TelegramCommandExecutor,
  TelegramCommandInput
} from '../telegramBotService.ts';
import type {
  OutboundHttpClient,
  OutboundJsonResult,
  OutboundMultipartRequestOptions,
  OutboundRequestError,
  OutboundRequestOptions
} from '../outboundRequestService.ts';
import { createRuntimeLifecycle } from '../runtimeLifecycleService.ts';
import { DEFAULT_CLIENT_TYPE } from '../../config/connectionDefaults.js';

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

const BOT_CONFIG: TelegramBotConfig = {
  enabled: true,
  botToken: 'fixture-token',
  chatId: 'fixture-chat',
  allowedUserIds: []
};

// 1x1 透明 PNG，远小于 Telegram 的 10MB 限制
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

type CapturedCall =
  | { kind: 'json'; url: string; options: OutboundRequestOptions }
  | { kind: 'text'; url: string; options: OutboundRequestOptions }
  | { kind: 'multipart'; url: string; options: OutboundMultipartRequestOptions };

type JsonCall = Extract<CapturedCall, { kind: 'json' }>;

interface FakeOutbound {
  client: OutboundHttpClient;
  calls: CapturedCall[];
}

/** 假出站端口：记录调用并按 call 返回 Promise；sendPhoto 之外的响应均为 Telegram JSON 包装。 */
function createOutboundFake(
  handler: (call: CapturedCall) => OutboundJsonResult | Promise<OutboundJsonResult>
): FakeOutbound {
  const calls: CapturedCall[] = [];
  const client: OutboundHttpClient = {
    requestJson: (url: string, options: OutboundRequestOptions = {}) => {
      const call: JsonCall = { kind: 'json', url, options };
      calls.push(call);
      return Promise.resolve().then(() => handler(call));
    },
    requestText: (_url: string, _options: OutboundRequestOptions = {}) => {
      throw new Error('Telegram bot never uses the text port');
    },
    requestMultipart: (url: string, options: OutboundMultipartRequestOptions) => {
      const call: CapturedCall = { kind: 'multipart', url, options };
      calls.push(call);
      return Promise.resolve().then(() => handler(call));
    }
  };
  return { client, calls };
}

function ok(data: unknown = {}): OutboundJsonResult {
  return { status: 200, data };
}

function telegramOk(result: unknown = {}): OutboundJsonResult {
  return ok({ ok: true, result });
}

function cancelledError(): OutboundRequestError {
  return Object.assign(new Error('出站请求已被取消'), {
    kind: 'cancelled' as const,
    code: 'AGENT_OUTBOUND_CANCELLED',
    statusCode: 499,
    details: {},
    retryable: false
  });
}

function networkError(): OutboundRequestError {
  return Object.assign(new Error('出站请求网络失败: offline'), {
    kind: 'network' as const,
    code: 'AGENT_OUTBOUND_NETWORK',
    statusCode: 502,
    details: {},
    retryable: true
  });
}

/** 出站端口把 Telegram 409 的上游描述放在 details.body，message 只说明状态码。 */
function conflictError(): OutboundRequestError {
  return Object.assign(new Error('上游返回非成功状态 409'), {
    kind: 'http-error' as const,
    code: 'AGENT_OUTBOUND_HTTP_STATUS',
    statusCode: 409,
    details: {
      status: 409,
      statusText: 'Conflict',
      body: '{"ok":false,"description":"Conflict: terminated by other getUpdates request"}'
    },
    retryable: false
  });
}

/** 模拟挂起的长轮询：会话停止（signal abort）时立即拒绝为 cancelled。 */
function pendingUntilAborted(call: CapturedCall): Promise<OutboundJsonResult> {
  return new Promise<OutboundJsonResult>((_resolve, reject) => {
    const { signal } = call.options;
    if (!signal) throw new Error('getUpdates 必须携带会话 signal');
    if (signal.aborted) {
      reject(cancelledError());
      return;
    }
    signal.addEventListener('abort', () => reject(cancelledError()), { once: true });
  });
}

async function waitFor(predicate: () => boolean, { timeout = 1_000, interval = 5 } = {}): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error('condition not met before timeout');
}

function getUpdatesCalls(calls: CapturedCall[]): JsonCall[] {
  return calls.filter((call): call is JsonCall => call.kind === 'json' && call.url.endsWith('/getUpdates'));
}

function sendMessageCalls(calls: CapturedCall[]): JsonCall[] {
  return calls.filter((call): call is JsonCall => call.kind === 'json' && call.url.endsWith('/sendMessage'));
}

/** 请求体按 JSON 记录为 unknown，断言前显式收窄为对象。 */
function readJsonBody(call: JsonCall): Record<string, unknown> {
  const body = call.options.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    assert.fail('expected a JSON request body');
  }
  return body as Record<string, unknown>;
}

function sentTexts(outbound: FakeOutbound): string[] {
  return sendMessageCalls(outbound.calls).map(call => String(readJsonBody(call).text));
}

interface MessageOverrides {
  chatId?: string;
  userId?: string;
  isBot?: boolean;
}

function messageUpdate(updateId: number, text: string, overrides: MessageOverrides = {}): Record<string, unknown> {
  const chatId = overrides.chatId ?? 'fixture-chat';
  const userId = overrides.userId ?? 'fixture-chat';
  return {
    update_id: updateId,
    message: {
      chat: { id: chatId },
      from: { id: userId, is_bot: overrides.isBot ?? false },
      text
    }
  };
}

/** 第一轮返回给定更新，之后挂起直到会话停止，模拟真实长轮询。 */
function deliverOnce(updates: unknown[]): (call: CapturedCall) => OutboundJsonResult | Promise<OutboundJsonResult> {
  let delivered = false;
  return call => {
    if (call.url.endsWith('/getUpdates')) {
      if (!delivered) {
        delivered = true;
        return telegramOk(updates);
      }
      return pendingUntilAborted(call);
    }
    return telegramOk({ message_id: 1 });
  };
}

const activeServices = new Set<TelegramBotService>();

function createService(overrides: TelegramBotServiceOverrides = {}): TelegramBotService {
  const service = createTelegramBotService({ logger: silentLogger, ...overrides });
  activeServices.add(service);
  return service;
}

afterEach(async () => {
  for (const service of activeServices) {
    await service.stop('test-cleanup');
  }
  activeServices.clear();
});

describe('Telegram polling lifecycle', () => {
  it('cancels the in-flight long poll on stop and uses an independent timeout', async () => {
    const outbound = createOutboundFake(call => (
      call.url.endsWith('/getUpdates') ? pendingUntilAborted(call) : telegramOk()
    ));
    const service = createService({ outbound: outbound.client });

    service.init(BOT_CONFIG);
    await waitFor(() => getUpdatesCalls(outbound.calls).length === 1);

    const [poll] = getUpdatesCalls(outbound.calls);
    assert.match(poll.url, /^https:\/\/api\.telegram\.org\/botfixture-token\/getUpdates$/);
    assert.equal(poll.options.method, 'POST');
    assert.deepEqual(poll.options.body, {
      offset: 0,
      timeout: TELEGRAM_LONG_POLL_SECONDS,
      allowed_updates: ['message']
    });
    // 长轮询时限独立于出站端口缺省时限，且大于 Telegram 停留时长
    assert.equal(poll.options.timeoutMs, TELEGRAM_LONG_POLL_TIMEOUT_MS);
    assert.ok(TELEGRAM_LONG_POLL_TIMEOUT_MS > TELEGRAM_LONG_POLL_SECONDS * 1000);
    const signal = poll.options.signal;
    if (!(signal instanceof AbortSignal)) assert.fail('getUpdates 必须携带会话 signal');
    assert.equal(signal.aborted, false);
    assert.equal(service.getStatus().polling, true);

    const startedAt = Date.now();
    const result = await service.stop('test-close');
    const elapsed = Date.now() - startedAt;

    assert.equal(result.stopped, true);
    assert.equal(signal.aborted, true);
    assert.ok(elapsed < 500, `stop took ${elapsed}ms`);
    assert.equal(service.getStatus().polling, false);
  });

  it('cancels the retry wait after a polling failure without replaying the read', async () => {
    let getUpdatesCount = 0;
    const outbound = createOutboundFake(call => {
      if (call.url.endsWith('/getUpdates')) {
        getUpdatesCount += 1;
        return Promise.reject(networkError());
      }
      return telegramOk();
    });
    const service = createService({ outbound: outbound.client });

    service.init(BOT_CONFIG);
    await waitFor(() => getUpdatesCount === 1);

    const startedAt = Date.now();
    await service.stop('test-close');
    const elapsed = Date.now() - startedAt;

    // 失败后的 5 秒退避等待已被取消；停止后不会再发起读取
    assert.ok(elapsed < 500, `stop took ${elapsed}ms`);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(getUpdatesCount, 1);
  });

  it('keeps suppressing the multi-instance getUpdates conflict in the outbound error shape', async () => {
    let getUpdatesCount = 0;
    const errors: string[] = [];
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error(message: string) {
        errors.push(message);
      }
    };
    const outbound = createOutboundFake(call => {
      if (call.url.endsWith('/getUpdates')) {
        getUpdatesCount += 1;
        return Promise.reject(conflictError());
      }
      return telegramOk();
    });
    const service = createService({ outbound: outbound.client, logger });

    service.init(BOT_CONFIG);
    await waitFor(() => getUpdatesCount === 1);
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(errors.includes('轮询错误'), false);
  });

  it('keeps a single poller across repeated initialization and configuration changes', async () => {
    const outbound = createOutboundFake(call => (
      call.url.endsWith('/getUpdates') ? pendingUntilAborted(call) : telegramOk()
    ));
    const service = createService({ outbound: outbound.client });

    service.init({ ...BOT_CONFIG, botToken: 'token-a' });
    await waitFor(() => getUpdatesCalls(outbound.calls).length === 1);
    const first = getUpdatesCalls(outbound.calls)[0];
    assert.match(first.url, /token-a\/getUpdates$/);
    assert.equal(service.getStatus().generation, 1);

    service.init({ ...BOT_CONFIG, botToken: 'token-b' });
    const firstSignal = first.options.signal;
    if (!(firstSignal instanceof AbortSignal)) assert.fail('getUpdates 必须携带会话 signal');
    assert.equal(firstSignal.aborted, true);
    await waitFor(() => getUpdatesCalls(outbound.calls).some(call => call.url.includes('token-b')));
    assert.equal(service.getStatus().generation, 2);
    assert.equal(service.getStatus().polling, true);

    const second = getUpdatesCalls(outbound.calls).find(call => call.url.includes('token-b'));
    if (!second) assert.fail('expected the reconfigured poller');
    const secondSignal = second.options.signal;
    if (!(secondSignal instanceof AbortSignal)) assert.fail('getUpdates 必须携带会话 signal');
    // 新配置禁用后不保留任何轮询者
    service.init({ ...BOT_CONFIG, botToken: 'token-b', enabled: false });
    assert.equal(secondSignal.aborted, true);
    assert.equal(service.getStatus().polling, false);
    assert.equal(service.getStatus().generation, 2);
  });

  it('does not execute commands that were still pending when the poller stopped', async () => {
    let updateDelivered = false;
    let sendBlocked = false;
    let releaseSend!: () => void;
    const sendGate = new Promise<void>(resolve => {
      releaseSend = resolve;
    });
    const update = messageUpdate(5, '/fight 1-7');
    const outbound = createOutboundFake(call => {
      if (call.url.endsWith('/getUpdates')) {
        if (!updateDelivered) {
          updateDelivered = true;
          return telegramOk([update]);
        }
        return pendingUntilAborted(call);
      }
      if (call.url.endsWith('/sendMessage')) {
        if (!sendBlocked) {
          sendBlocked = true;
          return sendGate.then(() => telegramOk({ message_id: 1 }));
        }
        return telegramOk({ message_id: 2 });
      }
      return telegramOk();
    });
    const execCalls: Array<Parameters<TelegramCommandExecutor>> = [];
    const service = createService({
      outbound: outbound.client,
      getTaskStatus: () => ({ isRunning: true, taskName: '旧任务' }),
      stopCurrentTask: () => ({ success: true }),
      execMaaCommand: (...args: Parameters<TelegramCommandExecutor>) => {
        execCalls.push(args);
        return Promise.resolve({});
      }
    });

    service.init(BOT_CONFIG);
    await waitFor(() => sendBlocked);

    // 命令停在“停止当前任务后等待进程释放”阶段时关闭会话
    await service.stop('test-close');
    releaseSend();
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.deepEqual(execCalls, []);
    assert.equal(service.getStatus().offset, 6);
  });

  it('preserves authorization, offset and command semantics', async () => {
    const updates = [
      {
        update_id: 10,
        message: {
          chat: { id: '999' },
          from: { id: '999', is_bot: false },
          text: '/fight 8-8'
        }
      },
      messageUpdate(11, '/fight 1-7')
    ];
    const outbound = createOutboundFake(deliverOnce(updates));
    const execCalls: Array<Parameters<TelegramCommandExecutor>> = [];
    const service = createService({
      outbound: outbound.client,
      getTaskStatus: () => ({ isRunning: false }),
      stopCurrentTask: () => ({ success: true }),
      execMaaCommand: (...args: Parameters<TelegramCommandExecutor>) => {
        execCalls.push(args);
        return Promise.resolve({});
      }
    });

    service.init(BOT_CONFIG);
    await waitFor(() => execCalls.length === 1);
    await waitFor(() => sendMessageCalls(outbound.calls).length === 1);

    assert.deepEqual(execCalls, [['fight', ['1-7'], '刷关卡 1-7', 'combat']]);
    assert.equal(service.getStatus().offset, 12);

    // 未授权用户的消息不产生回复；唯一回复来自授权用户的作战命令
    const messages = sentTexts(outbound);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /已开始执行理智作战/);
  });
});

describe('Telegram update validation', () => {
  it('acknowledges malformed updates without dispatching or corrupting the offset', async () => {
    const updates = [
      messageUpdate(20, '/fight 1-7'),
      { not_an_update: true },
      { update_id: 21, message: { chat: { id: 'fixture-chat' } } },
      { update_id: 22, message: { chat: { id: 'fixture-chat' }, from: { id: 'fixture-chat', is_bot: false }, text: 42 } },
      { update_id: 23, message: { chat: { id: 'fixture-chat' }, from: { is_bot: false }, text: '/fight 2-7' } }
    ];
    const outbound = createOutboundFake(deliverOnce(updates));
    const execCalls: Array<Parameters<TelegramCommandExecutor>> = [];
    const errors: string[] = [];
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error(message: string) {
        errors.push(message);
      }
    };
    const service = createService({
      outbound: outbound.client,
      logger,
      getTaskStatus: () => ({ isRunning: false }),
      execMaaCommand: (...args: Parameters<TelegramCommandExecutor>) => {
        execCalls.push(args);
        return Promise.resolve({});
      }
    });

    service.init(BOT_CONFIG);
    await waitFor(() => execCalls.length === 1);
    await waitFor(() => sentTexts(outbound).length === 1);
    await new Promise(resolve => setTimeout(resolve, 20));

    // 只有第一条完整消息派发；缺少整数 update_id 的条目无法推进 offset，
    // 其余不完整消息按 Telegram 语义确认 offset 但不执行命令。
    assert.deepEqual(execCalls, [['fight', ['1-7'], '刷关卡 1-7', 'combat']]);
    assert.equal(service.getStatus().offset, 24);
    assert.equal(sentTexts(outbound).length, 1);
    assert.equal(errors.includes('处理消息错误'), false);
  });
});

describe('Telegram command errors', () => {
  it('reports a failing device command with the existing message and does not retry it', async () => {
    const outbound = createOutboundFake(deliverOnce([messageUpdate(30, '/fight 1-7')]));
    let execCount = 0;
    const service = createService({
      outbound: outbound.client,
      getTaskStatus: () => ({ isRunning: false }),
      execMaaCommand: () => {
        execCount += 1;
        return Promise.reject(new Error('MAA 不可用'));
      }
    });

    service.init(BOT_CONFIG);
    await waitFor(() => sentTexts(outbound).length === 1);

    assert.equal(execCount, 1);
    assert.match(sentTexts(outbound)[0], /^❌ 执行失败: 执行失败: MAA 不可用$/);
  });

  it('keeps the unknown-command reply without dispatching execution', async () => {
    const outbound = createOutboundFake(deliverOnce([messageUpdate(40, '/nope arg')]));
    let execCount = 0;
    const service = createService({
      outbound: outbound.client,
      execMaaCommand: () => {
        execCount += 1;
        return Promise.resolve({});
      }
    });

    service.init(BOT_CONFIG);
    await waitFor(() => sentTexts(outbound).length === 1);

    assert.equal(execCount, 0);
    assert.match(sentTexts(outbound)[0], /^❌ 未知命令: nope\n\n使用 \/help 查看可用命令$/);
  });

  it('reports missing arguments and invalid flow types without starting execution', async () => {
    const outbound = createOutboundFake(deliverOnce([messageUpdate(50, '/fight')]));
    let execCount = 0;
    const service = createService({
      outbound: outbound.client,
      execMaaCommand: () => {
        execCount += 1;
        return Promise.resolve({});
      }
    });

    service.init(BOT_CONFIG);
    await waitFor(() => sentTexts(outbound).length === 1);

    assert.equal(execCount, 0);
    assert.equal(sentTexts(outbound)[0], '❌ 请指定关卡，例如：/fight 1-7');

    const flowOutbound = createOutboundFake(deliverOnce([messageUpdate(51, '/run unknown')]));
    let scheduleCount = 0;
    const flowService = createService({
      outbound: flowOutbound.client,
      executeScheduleNow: () => {
        scheduleCount += 1;
        return Promise.resolve({});
      }
    });

    flowService.init(BOT_CONFIG);
    await waitFor(() => sentTexts(flowOutbound).length === 1);

    assert.equal(scheduleCount, 0);
    assert.match(sentTexts(flowOutbound)[0], /^❌ 无效的流程类型: unknown/);
  });

  it('reports screenshot failures with the ADB hint instead of throwing', async () => {
    const outbound = createOutboundFake(deliverOnce([messageUpdate(60, '截图')]));
    const service = createService({
      outbound: outbound.client,
      resolveConnection: async () => ({ adbPath: '/fixture/adb', address: 'fixture-device:5555' }),
      captureScreen: async () => {
        throw new Error('adb offline');
      }
    });

    service.init(BOT_CONFIG);
    await waitFor(() => sentTexts(outbound).length === 2);

    const [, failure] = sentTexts(outbound);
    assert.equal(failure, '❌ 截图失败: adb offline\n\n请检查 ADB 连接是否正常');
  });
});

describe('Telegram command parsing', () => {
  it('parses keyword, argument and slash forms into explicit command input', () => {
    assert.deepEqual(parseTelegramCommand('帮助'), {
      name: 'help',
      rawName: 'help',
      args: [],
      source: 'keyword'
    });
    assert.deepEqual(parseTelegramCommand('刷 1-7'), {
      name: 'fight',
      rawName: 'fight',
      args: ['1-7'],
      source: 'fight'
    });
    assert.deepEqual(parseTelegramCommand('prts://12345'), {
      name: 'copilot',
      rawName: 'copilot',
      args: ['prts://12345'],
      source: 'copilot-uri'
    });
    assert.deepEqual(parseTelegramCommand('/run automation'), {
      name: 'run',
      rawName: 'run',
      args: ['automation'],
      source: 'slash'
    });
    assert.deepEqual(parseTelegramCommand('/nope arg'), {
      name: null,
      rawName: 'nope',
      args: ['arg'],
      source: 'slash'
    });
    assert.equal(parseTelegramCommand('普通聊天'), null);
    assert.equal(parseTelegramCommand(''), null);
  });

  it('resolves defaults into typed command requests', () => {
    const request = (name: TelegramCommandInput['name'], args: string[] = [], rawName = name ?? ''): TelegramCommandInput => ({
      name,
      rawName,
      args,
      source: name === null ? 'slash' : 'keyword'
    });

    assert.deepEqual(resolveTelegramCommandRequest(request('roguelike')), { kind: 'roguelike', theme: 'Sami' });
    assert.deepEqual(resolveTelegramCommandRequest(request('startup')), {
      kind: 'startup',
      clientType: DEFAULT_CLIENT_TYPE
    });
    assert.deepEqual(resolveTelegramCommandRequest(request('closedown', ['Bilibili'])), {
      kind: 'closedown',
      clientType: 'Bilibili'
    });
    assert.deepEqual(resolveTelegramCommandRequest(request('run')), { kind: 'run', flowType: 'automation' });
    assert.deepEqual(resolveTelegramCommandRequest(request('fight')), { kind: 'fight', stage: null });
    assert.deepEqual(resolveTelegramCommandRequest(request('copilot', ['prts://1'])), { kind: 'copilot', uri: 'prts://1' });
    assert.deepEqual(resolveTelegramCommandRequest(request(null, ['x'], 'nope')), { kind: 'unknown', rawName: 'nope' });
  });
});

describe('Telegram upload', () => {
  it('uploads screenshots as native multipart with the original file name', async () => {
    let updateDelivered = false;
    const photoCalls: CapturedCall[] = [];
    const outbound = createOutboundFake(call => {
      if (call.url.endsWith('/getUpdates')) {
        if (!updateDelivered) {
          updateDelivered = true;
          return telegramOk([messageUpdate(1, '/screenshot')]);
        }
        return pendingUntilAborted(call);
      }
      if (call.url.endsWith('/sendPhoto')) {
        photoCalls.push(call);
        return telegramOk({ message_id: 3 });
      }
      return telegramOk({ message_id: 2 });
    });
    const captured: Array<[unknown, unknown]> = [];
    const service = createService({
      outbound: outbound.client,
      resolveConnection: async () => ({ adbPath: '/fixture/adb', address: 'fixture-device:5555' }),
      captureScreen: async (adbPath, address) => {
        captured.push([adbPath, address]);
        return { image: TINY_PNG_BASE64, timestamp: '2026-10-28T00:00:00.000Z' };
      }
    });

    service.init(BOT_CONFIG);
    await waitFor(() => photoCalls.length > 0);

    assert.deepEqual(captured, [['/fixture/adb', 'fixture-device:5555']]);
    const photoRequest = photoCalls[0];
    if (!photoRequest || photoRequest.kind !== 'multipart') assert.fail('expected a multipart upload');
    assert.match(photoRequest.url, /^https:\/\/api\.telegram\.org\/botfixture-token\/sendPhoto$/);
    assert.equal(photoRequest.options.timeoutMs, 30_000);
    if (!(photoRequest.options.signal instanceof AbortSignal)) assert.fail('sendPhoto 必须携带会话 signal');

    const formData = photoRequest.options.formData;
    if (!(formData instanceof FormData)) assert.fail('expected native FormData');
    assert.equal(formData.get('chat_id'), 'fixture-chat');
    assert.equal(formData.get('caption'), '📸 当前屏幕截图');
    const photo = formData.get('photo');
    if (!(photo instanceof File)) assert.fail('expected an uploaded photo part');
    assert.equal(photo.name, 'screenshot.png');
    assert.equal(photo.type, 'image/png');
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), Buffer.from(TINY_PNG_BASE64, 'base64'));

    // 线上 multipart 序列化由运行时完成；fixture 验证 boundary、字段名、文件名与原始字节
    const wire = new Response(formData);
    const contentType = wire.headers.get('content-type');
    if (!contentType) assert.fail('missing multipart content type');
    assert.match(contentType, /^multipart\/form-data; boundary=/);
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) assert.fail('missing multipart boundary');
    const boundary = boundaryMatch[1];
    const bodyText = Buffer.from(await wire.arrayBuffer()).toString('latin1');
    const parts = bodyText.split(`--${boundary}`).filter(part => part.trim() && !part.startsWith('--'));
    assert.equal(parts.length, 3);
    const photoPart = parts.find(part => part.includes('name="photo"'));
    if (!photoPart) assert.fail('missing photo part');
    assert.match(photoPart, /filename="screenshot\.png"/);
    assert.match(photoPart, /Content-Type: image\/png/i);
    const photoBytes = photoPart.split('\r\n\r\n').slice(1).join('\r\n\r\n');
    assert.equal(
      Buffer.from(photoBytes, 'latin1').subarray(0, 8).toString('hex'),
      Buffer.from(TINY_PNG_BASE64, 'base64').subarray(0, 8).toString('hex')
    );
    const chatPart = parts.find(part => part.includes('name="chat_id"'));
    if (!chatPart) assert.fail('missing chat_id part');
    assert.match(chatPart, /fixture-chat/);
    const captionPart = parts.find(part => part.includes('name="caption"'));
    if (!captionPart) assert.fail('missing caption part');
    const captionText = Buffer.from(captionPart.split('\r\n\r\n')[1] ?? '', 'latin1').toString('utf8');
    assert.equal(captionText, '📸 当前屏幕截图\r\n');
  });
});

describe('Telegram runtime close step', () => {
  it('registers one close step that stops polling and rejects restarts after close', async () => {
    const outbound = createOutboundFake(call => (
      call.url.endsWith('/getUpdates') ? pendingUntilAborted(call) : telegramOk()
    ));
    const service = createService({ outbound: outbound.client });
    const lifecycle = createRuntimeLifecycle({ logger: silentLogger, closeDeadlineMs: 1_000 });

    assert.deepEqual(service.attachLifecycle(lifecycle), { attached: true, duplicate: false });
    assert.deepEqual(service.attachLifecycle(lifecycle), { attached: true, duplicate: true });

    service.init(BOT_CONFIG);
    await lifecycle.start();
    await waitFor(() => getUpdatesCalls(outbound.calls).length === 1);

    const summary = await lifecycle.close('test-close');
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.steps.map(step => [step.name, step.status]), [['telegram-bot', 'closed']]);
    assert.equal(service.getStatus().polling, false);

    // 关闭后即使再次收到配置也不启动新的轮询者
    service.init(BOT_CONFIG);
    assert.equal(service.getStatus().polling, false);
  });
});
