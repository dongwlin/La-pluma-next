/**
 * 日志关联与脱敏工具测试（请求 id、日志上下文、脱敏规则）
 * 运行: node --test server/src/utils/__tests__/logging.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getLogContext } from '../logContext.ts';
import {
  REDACTED,
  isSensitiveLogKey,
  redactLogData,
  redactLogText
} from '../logRedaction.ts';
import {
  REQUEST_ID_HEADER,
  REQUEST_ID_MAX_LENGTH,
  createRequestId,
  normalizeRequestId,
  requestIdMiddleware,
  resolveRequestId
} from '../requestContext.ts';
import type { RequestIdRequestLike } from '../requestContext.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

describe('logging', () => {
  it('校验并生成有限长度的请求 id，非法值不复用', () => {
    assert.equal(normalizeRequestId('abc'), 'abc');
    assert.equal(normalizeRequestId('A.b_c:d-1'), 'A.b_c:d-1');
    assert.equal(normalizeRequestId('  spaced-id  '), 'spaced-id');
    assert.equal(normalizeRequestId('x'.repeat(REQUEST_ID_MAX_LENGTH)), 'x'.repeat(REQUEST_ID_MAX_LENGTH));

    for (const invalid of [
      '',
      '   ',
      'x'.repeat(REQUEST_ID_MAX_LENGTH + 1),
      'bad value',
      'bad\nvalue',
      'bad/value',
      '-leading-dash',
      '请求-id',
      ['a', 'b'],
      42,
      undefined
    ]) {
      assert.equal(normalizeRequestId(invalid), null, `${String(invalid)} 应视为非法请求 id`);
    }

    assert.equal(resolveRequestId('client-request-1'), 'client-request-1');
    assert.match(resolveRequestId('bad\nforged'), UUID_PATTERN);
    assert.match(resolveRequestId(undefined), UUID_PATTERN);
    assert.notEqual(createRequestId(), createRequestId());
  });

  it('请求 id 中间件写入 req.id、响应头与请求日志上下文', () => {
    const req: RequestIdRequestLike = { headers: { [REQUEST_ID_HEADER]: 'client-req-9' } };
    const headers: Record<string, string> = {};
    let contextInside: ReturnType<typeof getLogContext> | undefined;
    let handled = false;

    requestIdMiddleware(req, { setHeader: (name, value) => { headers[name] = value; } }, () => {
      handled = true;
      contextInside = getLogContext();
    });

    assert.equal(handled, true);
    assert.equal(req.id, 'client-req-9');
    assert.equal(headers[REQUEST_ID_HEADER], 'client-req-9');
    assert.equal(contextInside?.requestId, 'client-req-9');
    // 中间件返回后请求上下文结束，不把 id 泄漏给后续无关调用
    assert.deepEqual(getLogContext(), {});

    for (const headerValue of [undefined, 'x'.repeat(REQUEST_ID_MAX_LENGTH + 1), 'bad value']) {
      const fallbackReq: RequestIdRequestLike = {
        headers: headerValue === undefined ? {} : { [REQUEST_ID_HEADER]: headerValue }
      };
      const fallbackHeaders: Record<string, string> = {};
      let requestIdInside: string | undefined;
      requestIdMiddleware(fallbackReq, {
        setHeader: (name, value) => { fallbackHeaders[name] = value; }
      }, () => {
        requestIdInside = getLogContext().requestId;
      });

      assert.match(String(fallbackReq.id), UUID_PATTERN);
      assert.equal(fallbackHeaders[REQUEST_ID_HEADER], fallbackReq.id);
      assert.equal(requestIdInside, fallbackReq.id);
      assert.notEqual(fallbackReq.id, headerValue);
    }

    // 响应对象缺少 setHeader 时仍建立上下文
    const bareReq: RequestIdRequestLike = { headers: {} };
    let bareInside: string | undefined;
    requestIdMiddleware(bareReq, {}, () => {
      bareInside = getLogContext().requestId;
    });
    assert.equal(bareInside, bareReq.id);
  });

  it('脱敏结构化数据与文本中的凭据，且不修改调用方对象', () => {
    for (const key of [
      'authorization',
      'proxy-authorization',
      'cookie',
      'token',
      'botToken',
      'access_token',
      'password',
      'passwd',
      'clientSecret',
      'apiKey',
      'api_key',
      'privateKey',
      'credential',
      'ticket',
      'signature'
    ]) {
      assert.equal(isSensitiveLogKey(key), true, `${key} 应视为敏感字段`);
    }
    for (const key of ['runId', 'operationId', 'requestId', 'stage', 'address', 'lines', 'version']) {
      assert.equal(isSensitiveLogKey(key), false, `${key} 不应视为敏感字段`);
    }

    const input = {
      service: 'Notification',
      headers: { authorization: 'Bearer header-secret', accept: 'application/json' },
      body: {
        token: 'body-token',
        password: 'body-password',
        stage: '1-7',
        items: [{ ticket: 'signal-ticket', count: 2 }]
      }
    };
    const output = asRecord(redactLogData(input));
    const headers = asRecord(output.headers);
    const body = asRecord(output.body);
    const items = body.items as Array<Record<string, unknown>>;

    assert.equal(output.service, 'Notification');
    assert.equal(headers.authorization, REDACTED);
    assert.equal(headers.accept, 'application/json');
    assert.equal(body.token, REDACTED);
    assert.equal(body.password, REDACTED);
    assert.equal(body.stage, '1-7');
    assert.equal(items[0].ticket, REDACTED);
    assert.equal(items[0].count, 2);
    // 原对象保持不变
    assert.equal(input.body.token, 'body-token');
    assert.equal(input.headers.authorization, 'Bearer header-secret');

    const query = redactLogText('GET /webrtc-signaling/connect_client?token=signal-secret&deviceId=1-2');
    assert.ok(query.includes('token=[REDACTED]'));
    assert.ok(query.includes('deviceId=1-2'));
    assert.ok(!query.includes('signal-secret'));

    const header = redactLogText('Authorization: Bearer abc.def-123');
    assert.ok(header.includes('Authorization:'));
    assert.ok(header.includes(REDACTED));
    assert.ok(!header.includes('abc.def-123'));

    const bare = redactLogText('upstream rejected Bearer abc.def-123');
    assert.ok(bare.includes('Bearer'));
    assert.ok(!bare.includes('abc.def-123'));

    const json = redactLogText('{"token": "json-secret", "password":"p@ss", "stage": "1-7"}');
    assert.ok(json.includes('"token": "[REDACTED]"'));
    assert.ok(json.includes('"password":"[REDACTED]"'));
    assert.ok(json.includes('"stage": "1-7"'));
    assert.ok(!json.includes('json-secret'));

    const plain = '命令执行完成: 1-7, 退出码: 0';
    assert.equal(redactLogText(plain), plain);
    assert.ok(String(asRecord(redactLogData({ output: 'login ?token=log-secret&x=1' })).output).includes('token=[REDACTED]'));
  });

  it('Error、循环引用与过深结构以受限形式记录', () => {
    const errorValue = asRecord(redactLogData(new Error('request failed token=error-secret')));
    assert.equal(errorValue.name, 'Error');
    assert.ok(String(errorValue.message).includes(REDACTED));
    assert.ok(!String(errorValue.message).includes('error-secret'));
    assert.equal('stack' in errorValue, false);

    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    assert.equal(asRecord(redactLogData(cyclic)).self, '[Circular]');

    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let index = 0; index < 10; index += 1) deep = { nested: deep };
    let current: unknown = redactLogData(deep);
    for (let index = 0; index < 6; index += 1) current = asRecord(current).nested;
    assert.equal(current, '[Truncated]');
  });
});
