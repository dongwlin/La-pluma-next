import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOutboundHttpClient,
  isOutboundRequestError,
  isTransientOutboundStatus
} from '../outboundRequestService.ts';
import type {
  FetchInitLike,
  FetchLike,
  FetchResponseLike,
  OutboundRequestError
} from '../outboundRequestService.ts';

// ---------------------------------------------------------------------------
// fixture：注入 fetch、可控延迟与错误响应；不访问任何生产接口。
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

function recordCall(url: string, init?: FetchInitLike): RecordedCall {
  return {
    url,
    method: init?.method ?? 'GET',
    headers: { ...(init?.headers ?? {}) },
    body: init?.body,
    signal: init?.signal
  };
}

/** 响应桩：released 标记 text() 是否被读取，用于资源释放断言。 */
interface ResponseStub extends FetchResponseLike {
  readonly released: boolean;
}

function makeResponseStub(options: { status?: number; statusText?: string; bodyText?: string } = {}): ResponseStub {
  const status = options.status ?? 200;
  let released = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: options.statusText ?? '',
    text: async () => {
      released = true;
      return options.bodyText ?? '';
    },
    get released() {
      return released;
    }
  };
}

function makeJsonResponse(data: unknown, options: { status?: number; statusText?: string } = {}): ResponseStub {
  return makeResponseStub({ ...options, bodyText: JSON.stringify(data) });
}

type ScriptStep = () => ResponseStub | Promise<ResponseStub>;

interface ScriptedFetch {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
}

/** 按脚本顺序响应；脚本耗尽后的额外调用直接报错，让重试计数断言保持精确。 */
function makeScriptedFetch(steps: ScriptStep[]): ScriptedFetch {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(recordCall(url, init));
    const step = steps[calls.length - 1];
    if (!step) {
      throw new Error(`意外的第 ${calls.length} 次 fetch 调用（脚本只有 ${steps.length} 步）`);
    }
    return await step();
  };
  return { fetchImpl, calls };
}

/** 延迟响应的 fetch 桩：尊重传入 signal，abort 时以 abort 原因拒绝（模拟真实 fetch）。 */
function makeDelayedFetch(delayMs: number, respond: () => ResponseStub): ScriptedFetch {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = (url, init) => new Promise((resolve, reject) => {
    calls.push(recordCall(url, init));
    const timer = setTimeout(() => resolve(respond()), delayMs);
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      const reason = init?.signal?.reason;
      reject(reason instanceof Error ? reason : new Error('请求被中止'));
    }, { once: true });
  });
  return { fetchImpl, calls };
}

async function rejectsOutbound(
  promise: Promise<unknown>,
  check: (error: OutboundRequestError) => void
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== undefined, '预期出站请求失败，但成功了');
  assert.ok(isOutboundRequestError(caught), `预期 OutboundRequestError，实际: ${String(caught)}`);
  check(caught);
}

// ---------------------------------------------------------------------------
// 端口行为
// ---------------------------------------------------------------------------

test('requestJson 按缺省 GET 调用并解析 JSON 响应与状态', async () => {
  const { fetchImpl, calls } = makeScriptedFetch([
    () => makeJsonResponse({ ok: true, result: [1, 2] })
  ]);
  const client = createOutboundHttpClient({ fetch: fetchImpl });

  const result = await client.requestJson('https://upstream.example/data');

  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { ok: true, result: [1, 2] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://upstream.example/data');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers['Content-Type'], undefined);
});

test('requestJson 序列化请求体并补默认 Content-Type，保留调用方已有 Content-Type', async () => {
  const { fetchImpl, calls } = makeScriptedFetch([
    () => makeJsonResponse({ ok: true }),
    () => makeJsonResponse({ ok: true })
  ]);
  const client = createOutboundHttpClient({ fetch: fetchImpl });

  await client.requestJson('https://upstream.example/send', {
    method: 'POST',
    body: { chat_id: 1, text: 'hello' }
  });
  await client.requestJson('https://upstream.example/send', {
    method: 'POST',
    body: { chat_id: 2 },
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, '{"chat_id":1,"text":"hello"}');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.equal(calls[1].headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(calls[1].headers['Content-Type'], undefined);
});

test('requestText 返回状态与文本并原样透传请求体', async () => {
  const { fetchImpl, calls } = makeScriptedFetch([
    () => makeResponseStub({ bodyText: 'plain upstream text' })
  ]);
  const client = createOutboundHttpClient({ fetch: fetchImpl });

  const result = await client.requestText('https://upstream.example/notes', {
    method: 'POST',
    body: 'raw payload',
    headers: { 'X-Custom': 'kept' }
  });

  assert.equal(result.status, 200);
  assert.equal(result.text, 'plain upstream text');
  assert.equal(calls[0].body, 'raw payload');
  assert.equal(calls[0].headers['X-Custom'], 'kept');
});

test('requestMultipart 默认 POST、formData 原样透传且不强制 Content-Type', async () => {
  const formDataStub = { marker: 'form-data-instance' };
  const { fetchImpl, calls } = makeScriptedFetch([
    () => makeJsonResponse({ ok: true, result: { message_id: 7 } })
  ]);
  const client = createOutboundHttpClient({ fetch: fetchImpl });

  const result = await client.requestMultipart('https://upstream.example/upload', {
    formData: formDataStub,
    headers: { 'content-type': 'multipart/form-data; boundary=caller-provided' }
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { ok: true, result: { message_id: 7 } });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, formDataStub);
  assert.equal(calls[0].headers['content-type'], 'multipart/form-data; boundary=caller-provided');
});

// ---------------------------------------------------------------------------
// 错误映射：区分超时、主动取消、网络失败和非成功 HTTP
// ---------------------------------------------------------------------------

test('非成功 HTTP 映射为 http-error，携带状态与响应体片段且不重试', async () => {
  const notFound = makeResponseStub({ status: 404, statusText: 'Not Found', bodyText: 'no such resource' });
  const { fetchImpl, calls } = makeScriptedFetch([() => notFound]);
  const client = createOutboundHttpClient({ fetch: fetchImpl, baseRetryDelayMs: 1 });

  await rejectsOutbound(client.requestJson('https://upstream.example/missing'), error => {
    assert.equal(error.kind, 'http-error');
    assert.equal(error.code, 'AGENT_OUTBOUND_HTTP_STATUS');
    assert.equal(error.statusCode, 404);
    assert.equal(error.retryable, false);
    assert.deepEqual(error.details, {
      status: 404,
      statusText: 'Not Found',
      body: 'no such resource'
    });
  });
  assert.equal(calls.length, 1);
  assert.equal(notFound.released, true);
});

test('瞬时 HTTP 状态标记为可重试', async () => {
  const unavailable = makeResponseStub({ status: 503, statusText: 'Service Unavailable', bodyText: 'busy' });
  const { fetchImpl } = makeScriptedFetch([() => unavailable]);
  const client = createOutboundHttpClient({ fetch: fetchImpl, maxRetries: 0 });

  await rejectsOutbound(client.requestJson('https://upstream.example/busy'), error => {
    assert.equal(error.kind, 'http-error');
    assert.equal(error.statusCode, 503);
    assert.equal(error.retryable, true);
  });
  assert.equal(isTransientOutboundStatus(503), true);
  assert.equal(isTransientOutboundStatus(404), false);
});

test('网络失败映射为 network，安全读取标记可重试', async () => {
  const { fetchImpl, calls } = makeScriptedFetch([
    () => {
      throw new TypeError('connect ECONNREFUSED 127.0.0.1:443');
    }
  ]);
  const client = createOutboundHttpClient({ fetch: fetchImpl, maxRetries: 0 });

  await rejectsOutbound(client.requestJson('https://upstream.example/data'), error => {
    assert.equal(error.kind, 'network');
    assert.equal(error.code, 'AGENT_OUTBOUND_NETWORK');
    assert.equal(error.statusCode, 502);
    assert.equal(error.retryable, true);
    assert.match(String(error.details.cause), /ECONNREFUSED/);
  });
  assert.equal(calls.length, 1);
});

test('网络失败对写入标记为不可重试', async () => {
  const { fetchImpl } = makeScriptedFetch([
    () => {
      throw new TypeError('connect ECONNRESET');
    }
  ]);
  const client = createOutboundHttpClient({ fetch: fetchImpl });

  await rejectsOutbound(
    client.requestJson('https://upstream.example/send', { method: 'POST', body: { value: 1 } }),
    error => {
      assert.equal(error.kind, 'network');
      assert.equal(error.retryable, false);
    }
  );
});

test('超出显式时限映射为 timeout', async () => {
  const { fetchImpl, calls } = makeDelayedFetch(200, () => makeJsonResponse({ late: true }));
  const client = createOutboundHttpClient({ fetch: fetchImpl, maxRetries: 0 });

  await rejectsOutbound(
    client.requestJson('https://upstream.example/slow', { timeoutMs: 30 }),
    error => {
      assert.equal(error.kind, 'timeout');
      assert.equal(error.code, 'AGENT_OUTBOUND_TIMEOUT');
      assert.equal(error.statusCode, 504);
      assert.equal(error.retryable, true);
      assert.equal(error.details.timeoutMs, 30);
    }
  );
  assert.equal(calls.length, 1);
});

test('调用方主动取消映射为 cancelled，且不误报为超时', async () => {
  const controller = new AbortController();
  const { fetchImpl, calls } = makeDelayedFetch(500, () => makeJsonResponse({ late: true }));
  const client = createOutboundHttpClient({ fetch: fetchImpl });

  const pending = client.requestJson('https://upstream.example/long', {
    timeoutMs: 10_000,
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 10);

  await rejectsOutbound(pending, error => {
    assert.equal(error.kind, 'cancelled');
    assert.equal(error.code, 'AGENT_OUTBOUND_CANCELLED');
    assert.equal(error.statusCode, 499);
    assert.equal(error.retryable, false);
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test('进入前已取消的 signal 不发起请求', async () => {
  const controller = new AbortController();
  controller.abort();
  const { fetchImpl, calls } = makeScriptedFetch([
    () => {
      throw new Error('已取消的调用不应发起 fetch');
    }
  ]);
  const client = createOutboundHttpClient({ fetch: fetchImpl });

  await rejectsOutbound(
    client.requestJson('https://upstream.example/data', { signal: controller.signal }),
    error => assert.equal(error.kind, 'cancelled')
  );
  assert.equal(calls.length, 0);
});

test('成功状态但响应体非法 JSON 映射为 invalid-response', async () => {
  const broken = makeResponseStub({ status: 200, bodyText: 'not-json{' });
  const { fetchImpl, calls } = makeScriptedFetch([() => broken]);
  const client = createOutboundHttpClient({ fetch: fetchImpl, baseRetryDelayMs: 1 });

  await rejectsOutbound(client.requestJson('https://upstream.example/broken'), error => {
    assert.equal(error.kind, 'invalid-response');
    assert.equal(error.code, 'AGENT_OUTBOUND_RESPONSE_INVALID');
    assert.equal(error.statusCode, 502);
    assert.equal(error.retryable, false);
    assert.equal(error.details.status, 200);
    assert.equal(error.details.body, 'not-json{');
  });
  assert.equal(calls.length, 1);
  assert.equal(broken.released, true);
});

// ---------------------------------------------------------------------------
// 长轮询与生命周期 signal
// ---------------------------------------------------------------------------

test('timeoutMs null 不套普通短超时，长轮询由调用方 signal 控制生命周期', async () => {
  const { fetchImpl, calls } = makeDelayedFetch(120, () => makeJsonResponse({ updates: [] }));
  // 工厂缺省时限刻意设短于长轮询时长，证明 null 不继承普通短超时。
  const client = createOutboundHttpClient({ fetch: fetchImpl, defaultTimeoutMs: 30 });

  const result = await client.requestJson('https://upstream.example/getUpdates', {
    method: 'POST',
    body: { timeout: 30 },
    timeoutMs: null
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { updates: [] });
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// 重试：只有安全读取按有限次数重试，写入不自动重放
// ---------------------------------------------------------------------------

test('安全读取按有限次数重试瞬时失败后成功，失败响应已释放', async () => {
  const serviceUnavailable = makeResponseStub({ status: 503, statusText: 'Service Unavailable', bodyText: 'busy' });
  const recovered = makeJsonResponse({ recovered: true });
  const { fetchImpl, calls } = makeScriptedFetch([
    () => {
      throw new TypeError('connect ECONNREFUSED 127.0.0.1:443');
    },
    () => serviceUnavailable,
    () => recovered
  ]);
  const client = createOutboundHttpClient({ fetch: fetchImpl, baseRetryDelayMs: 1 });

  const result = await client.requestJson('https://upstream.example/data');

  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { recovered: true });
  assert.equal(calls.length, 3);
  assert.equal(serviceUnavailable.released, true);
  assert.equal(recovered.released, true);
});

test('重试达到上限后抛出最后一次错误', async () => {
  const { fetchImpl, calls } = makeScriptedFetch([
    () => {
      throw new TypeError('connect ECONNREFUSED');
    },
    () => {
      throw new TypeError('connect ECONNREFUSED');
    },
    () => {
      throw new TypeError('connect ECONNREFUSED');
    }
  ]);
  const client = createOutboundHttpClient({ fetch: fetchImpl, maxRetries: 2, baseRetryDelayMs: 1 });

  await rejectsOutbound(client.requestJson('https://upstream.example/data'), error => {
    assert.equal(error.kind, 'network');
  });
  assert.equal(calls.length, 3);
});

test('写入即使显式传入 retry 配置也不自动重放', async () => {
  const { fetchImpl, calls } = makeScriptedFetch([
    () => {
      throw new TypeError('connect ECONNRESET');
    }
  ]);
  const client = createOutboundHttpClient({ fetch: fetchImpl, baseRetryDelayMs: 1 });

  await rejectsOutbound(
    client.requestJson('https://upstream.example/send', {
      method: 'POST',
      body: { payload: 'notification' },
      retry: { maxRetries: 3 }
    }),
    error => {
      assert.equal(error.kind, 'network');
      assert.equal(error.retryable, false);
    }
  );
  assert.equal(calls.length, 1);
});

test('非瞬时 HTTP 状态不触发重试', async () => {
  const { fetchImpl, calls } = makeScriptedFetch([
    () => makeResponseStub({ status: 400, statusText: 'Bad Request', bodyText: 'bad input' })
  ]);
  const client = createOutboundHttpClient({ fetch: fetchImpl, baseRetryDelayMs: 1 });

  await rejectsOutbound(client.requestJson('https://upstream.example/data'), error => {
    assert.equal(error.kind, 'http-error');
  });
  assert.equal(calls.length, 1);
});

test('重试退避期间取消立即中止，不再发起后续尝试', async () => {
  const controller = new AbortController();
  const { fetchImpl, calls } = makeScriptedFetch([
    () => {
      throw new TypeError('connect ECONNREFUSED');
    }
  ]);
  const client = createOutboundHttpClient({ fetch: fetchImpl, baseRetryDelayMs: 500 });

  const pending = client.requestJson('https://upstream.example/data', { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);

  await rejectsOutbound(pending, error => assert.equal(error.kind, 'cancelled'));
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// 用法错误与工厂缺省
// ---------------------------------------------------------------------------

test('用法错误抛 TypeError 且不发起请求', async () => {
  const { fetchImpl, calls } = makeScriptedFetch([
    () => {
      throw new Error('用法错误不应发起 fetch');
    }
  ]);
  const client = createOutboundHttpClient({ fetch: fetchImpl });

  await assert.rejects(client.requestJson('', { body: { a: 1 } }), TypeError);
  await assert.rejects(
    client.requestJson('https://upstream.example/data', { method: 'GET', body: { a: 1 } }),
    TypeError
  );
  await assert.rejects(
    client.requestJson('https://upstream.example/data', { method: 'HEAD' }),
    TypeError
  );
  await assert.rejects(
    client.requestJson('https://upstream.example/data', { timeoutMs: 0 }),
    TypeError
  );
  await assert.rejects(
    client.requestJson('https://upstream.example/data', { retry: { maxRetries: -1 } }),
    TypeError
  );
  await assert.rejects(
    client.requestMultipart('https://upstream.example/upload', { formData: undefined }),
    TypeError
  );
  assert.equal(calls.length, 0);
});

test('工厂缺省值可被显式配置覆盖后按上限重试', async () => {
  const first = makeResponseStub({ status: 503, statusText: 'Service Unavailable' });
  const second = makeJsonResponse({ ok: true });
  const { fetchImpl, calls } = makeScriptedFetch([
    () => first,
    () => {
      throw new TypeError('connect ECONNREFUSED');
    },
    () => second
  ]);
  const client = createOutboundHttpClient({ fetch: fetchImpl, maxRetries: 2, baseRetryDelayMs: 1 });

  const result = await client.requestJson('https://upstream.example/data');
  assert.deepEqual(result.data, { ok: true });
  assert.equal(calls.length, 3);
  assert.equal(first.released, true);
});
