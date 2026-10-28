import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  TELEGRAM_LONG_POLL_SECONDS,
  TELEGRAM_LONG_POLL_TIMEOUT_MS,
  createTelegramBotService
} from '../telegramBotService.js';
import { createRuntimeLifecycle } from '../runtimeLifecycleService.ts';

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

const BOT_CONFIG = {
  enabled: true,
  botToken: 'fixture-token',
  chatId: 'fixture-chat',
  allowedUserIds: []
};

// 1x1 透明 PNG，远小于 Telegram 的 10MB 限制
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 假出站端口：记录调用并按 call 返回 Promise；sendPhoto 之外的响应均为 Telegram JSON 包装。 */
function createOutboundFake(handler) {
  const calls = [];
  const record = kind => (url, options = {}) => {
    const call = { kind, url, options };
    calls.push(call);
    return Promise.resolve().then(() => handler(call));
  };
  return {
    calls,
    requestJson: record('json'),
    requestText: record('text'),
    requestMultipart: record('multipart')
  };
}

function ok(data = {}) {
  return { status: 200, data };
}

function telegramOk(result = {}) {
  return ok({ ok: true, result });
}

function cancelledError() {
  return Object.assign(new Error('出站请求已被取消'), {
    kind: 'cancelled',
    code: 'AGENT_OUTBOUND_CANCELLED',
    statusCode: 499,
    details: {},
    retryable: false
  });
}

function networkError() {
  return Object.assign(new Error('出站请求网络失败: offline'), {
    kind: 'network',
    code: 'AGENT_OUTBOUND_NETWORK',
    statusCode: 502,
    details: {},
    retryable: true
  });
}

/** 出站端口把 Telegram 409 的上游描述放在 details.body，message 只说明状态码。 */
function conflictError() {
  return Object.assign(new Error('上游返回非成功状态 409'), {
    kind: 'http-error',
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
function pendingUntilAborted(call) {
  return new Promise((resolve, reject) => {
    const { signal } = call.options;
    if (!signal) throw new Error('getUpdates 必须携带会话 signal');
    if (signal.aborted) {
      reject(cancelledError());
      return;
    }
    signal.addEventListener('abort', () => reject(cancelledError()), { once: true });
  });
}

async function waitFor(predicate, { timeout = 1_000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error('condition not met before timeout');
}

function getUpdatesCalls(outbound) {
  return outbound.calls.filter(call => call.url.endsWith('/getUpdates'));
}

const activeServices = new Set();

function createService(options) {
  const service = createTelegramBotService({ logger: silentLogger, ...options });
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
    const service = createService({ outbound });

    service.init(BOT_CONFIG);
    await waitFor(() => getUpdatesCalls(outbound).length === 1);

    const [poll] = getUpdatesCalls(outbound);
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
    assert.ok(poll.options.signal instanceof AbortSignal);
    assert.equal(poll.options.signal.aborted, false);
    assert.equal(service.getStatus().polling, true);

    const startedAt = Date.now();
    const result = await service.stop('test-close');
    const elapsed = Date.now() - startedAt;

    assert.equal(result.stopped, true);
    assert.equal(poll.options.signal.aborted, true);
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
    const service = createService({ outbound });

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
    const errors = [];
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error(message) {
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
    const service = createService({ outbound, logger });

    service.init(BOT_CONFIG);
    await waitFor(() => getUpdatesCount === 1);
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(errors.includes('轮询错误'), false);
  });

  it('keeps a single poller across repeated initialization and configuration changes', async () => {
    const outbound = createOutboundFake(call => (
      call.url.endsWith('/getUpdates') ? pendingUntilAborted(call) : telegramOk()
    ));
    const service = createService({ outbound });

    service.init({ ...BOT_CONFIG, botToken: 'token-a' });
    await waitFor(() => getUpdatesCalls(outbound).length === 1);
    const first = getUpdatesCalls(outbound)[0];
    assert.match(first.url, /token-a\/getUpdates$/);
    assert.equal(service.getStatus().generation, 1);

    service.init({ ...BOT_CONFIG, botToken: 'token-b' });
    assert.equal(first.options.signal.aborted, true);
    await waitFor(() => getUpdatesCalls(outbound).some(call => call.url.includes('token-b')));
    assert.equal(service.getStatus().generation, 2);
    assert.equal(service.getStatus().polling, true);

    const second = getUpdatesCalls(outbound).find(call => call.url.includes('token-b'));
    // 新配置禁用后不保留任何轮询者
    service.init({ ...BOT_CONFIG, botToken: 'token-b', enabled: false });
    assert.equal(second.options.signal.aborted, true);
    assert.equal(service.getStatus().polling, false);
    assert.equal(service.getStatus().generation, 2);
  });

  it('does not execute commands that were still pending when the poller stopped', async () => {
    let updateDelivered = false;
    let sendBlocked = false;
    let releaseSend;
    const sendGate = new Promise(resolve => {
      releaseSend = resolve;
    });
    const update = {
      update_id: 5,
      message: {
        chat: { id: 'fixture-chat' },
        from: { id: 'fixture-chat', is_bot: false },
        text: '/fight 1-7'
      }
    };
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
    const execCalls = [];
    const service = createService({
      outbound,
      getTaskStatus: () => ({ isRunning: true, taskName: '旧任务' }),
      stopCurrentTask: () => ({ success: true }),
      execMaaCommand: (...args) => {
        execCalls.push(args);
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
    let updateDelivered = false;
    const updates = [
      {
        update_id: 10,
        message: {
          chat: { id: '999' },
          from: { id: '999', is_bot: false },
          text: '/fight 8-8'
        }
      },
      {
        update_id: 11,
        message: {
          chat: { id: 'fixture-chat' },
          from: { id: 'fixture-chat', is_bot: false },
          text: '/fight 1-7'
        }
      }
    ];
    const outbound = createOutboundFake(call => {
      if (call.url.endsWith('/getUpdates')) {
        if (!updateDelivered) {
          updateDelivered = true;
          return telegramOk(updates);
        }
        return pendingUntilAborted(call);
      }
      return telegramOk({ message_id: 7 });
    });
    const execCalls = [];
    const service = createService({
      outbound,
      getTaskStatus: () => ({ isRunning: false }),
      stopCurrentTask: () => ({ success: true }),
      execMaaCommand: (...args) => {
        execCalls.push(args);
      }
    });

    service.init(BOT_CONFIG);
    await waitFor(() => execCalls.length === 1);
    await waitFor(() => outbound.calls.some(call => call.url.endsWith('/sendMessage')));

    assert.deepEqual(execCalls, [['fight', ['1-7'], '刷关卡 1-7', 'combat']]);
    assert.equal(service.getStatus().offset, 12);

    // 未授权用户的消息不产生回复；唯一回复来自授权用户的作战命令
    const messages = outbound.calls.filter(call => call.url.endsWith('/sendMessage'));
    assert.equal(messages.length, 1);
    assert.match(messages[0].options.body.text, /已开始执行理智作战/);
  });
});

describe('Telegram upload', () => {
  it('uploads screenshots as native multipart with the original file name', async () => {
    let updateDelivered = false;
    let photoCall = null;
    const outbound = createOutboundFake(call => {
      if (call.url.endsWith('/getUpdates')) {
        if (!updateDelivered) {
          updateDelivered = true;
          return telegramOk([{
            update_id: 1,
            message: {
              chat: { id: 'fixture-chat' },
              from: { id: 'fixture-chat', is_bot: false },
              text: '/screenshot'
            }
          }]);
        }
        return pendingUntilAborted(call);
      }
      if (call.url.endsWith('/sendPhoto')) {
        photoCall = call;
        return telegramOk({ message_id: 3 });
      }
      return telegramOk({ message_id: 2 });
    });
    const captured = [];
    const service = createService({
      outbound,
      resolveConnection: async () => ({ adbPath: '/fixture/adb', address: 'fixture-device:5555' }),
      captureScreen: async (adbPath, address) => {
        captured.push([adbPath, address]);
        return { image: TINY_PNG_BASE64 };
      }
    });

    service.init(BOT_CONFIG);
    await waitFor(() => photoCall !== null);

    assert.deepEqual(captured, [['/fixture/adb', 'fixture-device:5555']]);
    assert.match(photoCall.url, /^https:\/\/api\.telegram\.org\/botfixture-token\/sendPhoto$/);
    assert.equal(photoCall.options.timeoutMs, 30_000);
    assert.ok(photoCall.options.signal instanceof AbortSignal);

    const formData = photoCall.options.formData;
    assert.ok(formData instanceof FormData);
    assert.equal(formData.get('chat_id'), 'fixture-chat');
    assert.equal(formData.get('caption'), '📸 当前屏幕截图');
    const photo = formData.get('photo');
    assert.equal(photo.name, 'screenshot.png');
    assert.equal(photo.type, 'image/png');
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), Buffer.from(TINY_PNG_BASE64, 'base64'));

    // 线上 multipart 序列化由运行时完成；fixture 验证 boundary、字段名、文件名与原始字节
    const wire = new Response(formData);
    const contentType = wire.headers.get('content-type');
    assert.match(contentType, /^multipart\/form-data; boundary=/);
    const boundary = contentType.match(/boundary=(.+)$/)[1];
    const bodyText = Buffer.from(await wire.arrayBuffer()).toString('latin1');
    const parts = bodyText.split(`--${boundary}`).filter(part => part.trim() && !part.startsWith('--'));
    assert.equal(parts.length, 3);
    const photoPart = parts.find(part => part.includes('name="photo"'));
    assert.match(photoPart, /filename="screenshot\.png"/);
    assert.match(photoPart, /Content-Type: image\/png/i);
    const photoBytes = photoPart.split('\r\n\r\n').slice(1).join('\r\n\r\n');
    assert.equal(Buffer.from(photoBytes, 'latin1').subarray(0, 8).toString('hex'), Buffer.from(TINY_PNG_BASE64, 'base64').subarray(0, 8).toString('hex'));
    assert.match(parts.find(part => part.includes('name="chat_id"')), /fixture-chat/);
    const captionPart = parts.find(part => part.includes('name="caption"'));
    const captionText = Buffer.from(captionPart.split('\r\n\r\n')[1] ?? '', 'latin1').toString('utf8');
    assert.equal(captionText, '📸 当前屏幕截图\r\n');
  });
});

describe('Telegram runtime close step', () => {
  it('registers one close step that stops polling and rejects restarts after close', async () => {
    const outbound = createOutboundFake(call => (
      call.url.endsWith('/getUpdates') ? pendingUntilAborted(call) : telegramOk()
    ));
    const service = createService({ outbound });
    const lifecycle = createRuntimeLifecycle({ logger: silentLogger, closeDeadlineMs: 1_000 });

    assert.deepEqual(service.attachLifecycle(lifecycle), { attached: true, duplicate: false });
    assert.deepEqual(service.attachLifecycle(lifecycle), { attached: true, duplicate: true });

    service.init(BOT_CONFIG);
    await lifecycle.start();
    await waitFor(() => getUpdatesCalls(outbound).length === 1);

    const summary = await lifecycle.close('test-close');
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.steps.map(step => [step.name, step.status]), [['telegram-bot', 'closed']]);
    assert.equal(service.getStatus().polling, false);

    // 关闭后即使再次收到配置也不启动新的轮询者
    service.init(BOT_CONFIG);
    assert.equal(service.getStatus().polling, false);
  });
});
