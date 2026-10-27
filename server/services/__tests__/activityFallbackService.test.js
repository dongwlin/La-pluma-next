import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getFallbackActivity, selectCurrentPenguinActivity } from '../activityFallbackService.js';

const activeWindow = {
  CN: {
    exist: true,
    openTime: 1000,
    closeTime: 3000
  }
};

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
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const liveWindow = { exist: true, openTime: now - 60000, closeTime: now + 3600000 };

  it('fetches penguin data through the outbound port and serves repeats from the cache', async () => {
    const calls = [];
    globalThis.fetch = async url => {
      calls.push(String(url));
      assert.ok(String(url).startsWith('https://penguin-stats.io/PenguinStats/api/v2/'));
      const body = String(url).includes('/zones')
        ? [{ zoneId: 'act_zone', type: 'ACTIVITY', zoneName: '矩阵活动', existence: { US: liveWindow } }]
        : [{ zoneId: 'act_zone', code: 'BD-1', existence: { US: liveWindow } }];
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) };
    };
    try {
      const activity = await getFallbackActivity('YoStarEN');

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
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('surfaces upstream http failures and clears the in-flight request for later retries', async () => {
    const calls = [];
    globalThis.fetch = async url => {
      calls.push(String(url));
      return { ok: false, status: 500, statusText: 'Internal Server Error', text: async () => 'upstream broken' };
    };
    try {
      await assert.rejects(getFallbackActivity('YoStarJP'), error => {
        assert.equal(error.kind, 'http-error');
        assert.equal(error.statusCode, 500);
        return true;
      });

      await assert.rejects(getFallbackActivity('YoStarJP'), error => {
        assert.equal(error.kind, 'http-error');
        return true;
      });
      assert.equal(calls.length, 4, 'each attempt fetches zones+stages; a failed request must not poison the cache or the in-flight map');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
