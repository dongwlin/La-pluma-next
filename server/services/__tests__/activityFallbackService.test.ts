import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { getFallbackActivity, selectCurrentPenguinActivity, supportsFallbackClient } from '../activityFallbackService.ts';

const activeWindow = {
  CN: {
    exist: true,
    openTime: 1000,
    closeTime: 3000
  }
};

/** 出站端口只读取状态与文本；测试替身用真实 Response 承载该结构。 */
interface StubResponse {
  status: number;
  statusText: string;
  body: string;
}

/** 以 t.mock.method 安装全局 fetch 替身，用例结束自动恢复；返回记录到的请求地址。 */
function stubFetch(t: TestContext, respond: (url: string) => StubResponse): string[] {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const response = respond(url);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText
    });
  });
  return calls;
}

/** assert.rejects 的入参是 unknown；出站错误按结构化字段读取。 */
function readFailureFields(error: unknown): { kind?: unknown; statusCode?: unknown } {
  return typeof error === 'object' && error !== null
    ? error as { kind?: unknown; statusCode?: unknown }
    : {};
}

describe('activity fallback selection', () => {
  it('selects the newest active activity and derives its stage code', () => {
    const zones = [
      {
        zoneId: 'old_zone',
        type: 'ACTIVITY',
        zoneName: '旧活动',
        existence: { CN: { exist: true, openTime: 500, closeTime: 3000 } }
      },
      {
        zoneId: 'act21mini_zone1',
        type: 'ACTIVITY',
        zoneName: '丛林症结',
        existence: activeWindow
      }
    ];
    const stages = [
      { zoneId: 'act21mini_zone1', code: 'BD-8', existence: activeWindow },
      { zoneId: 'act21mini_zone1', code: 'BD-1', existence: activeWindow },
      { zoneId: 'old_zone', code: 'OLD-1', existence: activeWindow }
    ];

    assert.deepEqual(selectCurrentPenguinActivity(zones, stages, 'CN', 2000), {
      code: 'BD',
      name: '丛林症结',
      source: 'penguin',
      startTime: 1000,
      endTime: 3000,
      stages: ['BD-1', 'BD-8']
    });
  });

  it('ignores future and expired activities', () => {
    const zones = [
      {
        zoneId: 'future',
        type: 'ACTIVITY',
        zoneName: '未来活动',
        existence: { CN: { exist: true, openTime: 3000, closeTime: 4000 } }
      },
      {
        zoneId: 'expired',
        type: 'ACTIVITY',
        zoneName: '过期活动',
        existence: { CN: { exist: true, openTime: 500, closeTime: 1500 } }
      }
    ];

    assert.equal(selectCurrentPenguinActivity(zones, [], 'CN', 2000), null);
  });

  it('does not treat permanent or non-activity zones as current events', () => {
    const zones = [{
      zoneId: 'main_1',
      type: 'MAINLINE',
      zoneName: '主线',
      existence: activeWindow
    }];
    const stages = [{ zoneId: 'main_1', code: '1-7', existence: activeWindow }];

    assert.equal(selectCurrentPenguinActivity(zones, stages, 'CN', 2000), null);
  });
});

describe('fallback activity fetch', () => {
  const now = Date.now();
  const liveWindow = { exist: true, openTime: now - 60000, closeTime: now + 3600000 };

  it('distinguishes supported servers from unsupported ones', () => {
    assert.equal(supportsFallbackClient('Official'), true);
    assert.equal(supportsFallbackClient('Bilibili'), true);
    assert.equal(supportsFallbackClient('YoStarEN'), true);
    assert.equal(supportsFallbackClient('Txwy'), false);
    assert.equal(supportsFallbackClient('UnknownServer'), false);
  });

  it('keeps Bilibili on the CN server mapping', async (t) => {
    const calls = stubFetch(t, url => {
      const body = url.includes('/zones')
        ? [{ zoneId: 'act_zone', type: 'ACTIVITY', zoneName: '矩阵活动', existence: { CN: liveWindow } }]
        : [{ zoneId: 'act_zone', code: 'BD-1', existence: { CN: liveWindow } }];
      return { status: 200, statusText: 'OK', body: JSON.stringify(body) };
    });

    const activity = await getFallbackActivity('Bilibili');

    assert.ok(activity);
    assert.equal(activity.code, 'BD');
    assert.ok(calls.some(url => url.includes('/zones?server=CN')));
    assert.ok(calls.some(url => url.includes('/stages?server=CN')));
  });

  it('fetches penguin data through the outbound port and serves repeats from the cache', async (t) => {
    const calls = stubFetch(t, url => {
      assert.ok(url.startsWith('https://penguin-stats.io/PenguinStats/api/v2/'));
      const body = url.includes('/zones')
        ? [{ zoneId: 'act_zone', type: 'ACTIVITY', zoneName: '矩阵活动', existence: { US: liveWindow } }]
        : [{ zoneId: 'act_zone', code: 'BD-1', existence: { US: liveWindow } }];
      return { status: 200, statusText: 'OK', body: JSON.stringify(body) };
    });

    const activity = await getFallbackActivity('YoStarEN');
    assert.ok(activity);
    assert.equal(activity.code, 'BD');
    assert.equal(activity.name, '矩阵活动');
    assert.equal(activity.source, 'penguin');
    assert.deepEqual(activity.stages, ['BD-1']);
    assert.equal(calls.length, 2);
    assert.ok(calls.some(url => url.includes('/zones?server=US')));
    assert.ok(calls.some(url => url.includes('/stages?server=US')));

    const cached = await getFallbackActivity('YoStarEN');
    assert.deepEqual(cached, activity);
    assert.equal(calls.length, 2, 'cached value must not re-fetch within the TTL');
  });

  it('surfaces upstream http failures and clears the in-flight request for later retries', async (t) => {
    const calls = stubFetch(t, () => ({
      status: 500,
      statusText: 'Internal Server Error',
      body: 'upstream broken'
    }));

    await assert.rejects(getFallbackActivity('YoStarJP'), error => {
      const failure = readFailureFields(error);
      assert.equal(failure.kind, 'http-error');
      assert.equal(failure.statusCode, 500);
      return true;
    });

    await assert.rejects(getFallbackActivity('YoStarJP'), error => {
      assert.equal(readFailureFields(error).kind, 'http-error');
      return true;
    });
    assert.equal(calls.length, 4, 'each attempt fetches zones+stages; a failed request must not poison the cache or the in-flight map');
  });
});
