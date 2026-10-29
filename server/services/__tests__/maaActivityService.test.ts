import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCurrentActivity,
  parseMaaActivityGroups
} from '../maaActivityService.ts';
import type { CachedActivity, MaaActivityRuntime } from '../maaActivityService.ts';

const NOW = 1_800_000_000_000;
const CLIENT = 'Official';
const TEN_MINUTES = 10 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

const OFFICIAL_MULTI_ACTIVITY = `Opening side story stages:
- 主线「相变临界」
  - 17-11: 固源岩
  - 17-10: 源岩
- SideStory「昨日海」
  - YW-8: 液化高能气体
  - YW-7: 转质盐组
  - YW-6: 全新装置
  - YW-4: 搓玉效率0.69
Opening mini games:
- 黑流树海刷钱`;

const TXWY_ACTIVITY = `Opening side story stages:
- SideStory「輓歌燃燒殆盡」復刻
  - SSReopen-EA: 代理 1~8
  - EA-8: 褐素纖維
  - EA-7: 半自然溶劑
  - EA-6: 研磨石
  - EA-3: 搓玉用
Opening mini games:
- 衛戍協議：盟約`;

const MINI_GAMES_ONLY = `Opening mini games:
- 黑流树海刷钱`;

function cachedActivity(overrides: Partial<CachedActivity> = {}): CachedActivity {
  return {
    code: 'YW',
    name: '昨日海',
    source: 'maa',
    startTime: null,
    endTime: null,
    stages: [],
    timestamp: NOW - 1000,
    ttl: TEN_MINUTES,
    ...overrides
  };
}

function runtime(overrides: MaaActivityRuntime = {}): MaaActivityRuntime {
  return {
    now: () => NOW,
    cache: new Map<string, CachedActivity>(),
    runActivity: async () => ({ stdout: '' }),
    readActivityTable: async () => ({ exists: true, modifiedAt: NOW - 1000 }),
    readFallback: async () => null,
    supportsFallback: () => true,
    loadConfig: async () => null,
    saveConfig: async () => undefined,
    ...overrides
  };
}

describe('parseMaaActivityGroups', () => {
  it('pairs each activity group name with its own stage code', () => {
    const parsed = parseMaaActivityGroups(OFFICIAL_MULTI_ACTIVITY);

    assert.equal(parsed.sawActivitySection, true);
    assert.equal(parsed.sawAnySection, true);
    assert.deepEqual(parsed.groups, [
      {
        label: '主线「相变临界」',
        name: '相变临界',
        code: null,
        stages: ['17-11', '17-10']
      },
      {
        label: 'SideStory「昨日海」',
        name: '昨日海',
        code: 'YW',
        stages: ['YW-8', 'YW-7', 'YW-6', 'YW-4']
      }
    ]);
  });

  it('derives the reopened stage code from the same group and keeps stage labels', () => {
    const parsed = parseMaaActivityGroups(TXWY_ACTIVITY);

    assert.equal(parsed.groups.length, 1);
    assert.equal(parsed.groups[0]?.name, '輓歌燃燒殆盡');
    assert.equal(parsed.groups[0]?.code, 'EA');
    assert.deepEqual(parsed.groups[0]?.stages, ['SSReopen-EA', 'EA-8', 'EA-7', 'EA-6', 'EA-3']);
  });

  it('keeps the full prefix of a four-letter stage code', () => {
    const parsed = parseMaaActivityGroups(`Opening side story stages:
- Critical Phase Transition
  - ABCD-8: item
  - ABCD-7: item`);

    assert.equal(parsed.groups[0]?.name, 'Critical Phase Transition');
    assert.equal(parsed.groups[0]?.code, 'ABCD');
  });

  it('reports sections without inventing an activity group', () => {
    assert.deepEqual(parseMaaActivityGroups(MINI_GAMES_ONLY), {
      groups: [],
      sawActivitySection: false,
      sawAnySection: true
    });
    assert.deepEqual(parseMaaActivityGroups(''), {
      groups: [],
      sawActivitySection: false,
      sawAnySection: false
    });
  });
});

describe('getCurrentActivity status contract', () => {
  it('serves a fresh memory cache without running the CLI', async () => {
    const entry = cachedActivity();
    let runCalls = 0;
    const snapshot = await getCurrentActivity(CLIENT, runtime({
      cache: new Map([[CLIENT, entry]]),
      runActivity: async () => {
        runCalls += 1;
        return { stdout: '' };
      },
      loadConfig: async () => {
        throw new Error('不应读取持久化缓存');
      }
    }));

    assert.equal(runCalls, 0);
    assert.deepEqual(snapshot, {
      code: 'YW',
      name: '昨日海',
      source: 'maa',
      startTime: null,
      endTime: null,
      stages: [],
      status: 'active',
      clientType: CLIENT,
      lastSuccessAt: entry.timestamp,
      dataUpdatedAt: null,
      failure: null
    });
  });

  it('falls back to a fresh persisted cache and refills the memory cache', async () => {
    const entry = cachedActivity();
    const cache = new Map<string, CachedActivity>();
    let runCalls = 0;
    const snapshot = await getCurrentActivity(CLIENT, runtime({
      cache,
      loadConfig: async () => ({ [CLIENT]: entry }),
      runActivity: async () => {
        runCalls += 1;
        return { stdout: '' };
      }
    }));

    assert.equal(runCalls, 0);
    assert.equal(snapshot.status, 'active');
    assert.equal(snapshot.code, 'YW');
    assert.equal(snapshot.lastSuccessAt, entry.timestamp);
    assert.deepEqual(cache.get(CLIENT), entry);
  });

  it('reads an active CLI group and records the activity table timestamp', async () => {
    const saved: Record<string, unknown>[] = [];
    const snapshot = await getCurrentActivity(CLIENT, runtime({
      runActivity: async () => ({
        stdout: `Opening side story stages:
- SideStory「昨日海」
  - YW-8: 液化高能气体`
      }),
      readActivityTable: async () => ({ exists: true, modifiedAt: NOW - 5000 }),
      saveConfig: async payload => {
        saved.push(payload);
      }
    }));

    assert.equal(snapshot.status, 'active');
    assert.equal(snapshot.code, 'YW');
    assert.equal(snapshot.name, '昨日海');
    assert.equal(snapshot.source, 'maa');
    assert.deepEqual(snapshot.stages, []);
    assert.equal(snapshot.lastSuccessAt, NOW);
    assert.equal(snapshot.dataUpdatedAt, NOW - 5000);
    assert.equal(snapshot.failure, null);
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0]?.[CLIENT], {
      code: 'YW',
      name: '昨日海',
      source: 'maa',
      startTime: null,
      endTime: null,
      stages: [],
      timestamp: NOW,
      ttl: TEN_MINUTES
    });
  });

  it('returns none only when the CLI output and a fresh activity table agree', async () => {
    let fallbackCalls = 0;
    const snapshot = await getCurrentActivity(CLIENT, runtime({
      runActivity: async () => ({ stdout: MINI_GAMES_ONLY }),
      readActivityTable: async () => ({ exists: true, modifiedAt: NOW - 1000 }),
      readFallback: async () => {
        fallbackCalls += 1;
        return null;
      }
    }));

    assert.equal(fallbackCalls, 0);
    assert.equal(snapshot.status, 'none');
    assert.equal(snapshot.code, null);
    assert.equal(snapshot.source, 'maa');
    assert.equal(snapshot.lastSuccessAt, NOW);
    assert.equal(snapshot.dataUpdatedAt, NOW - 1000);
    assert.equal(snapshot.failure, null);
  });

  it('does not treat an unrecognized non-empty CLI output as none', async () => {
    let fallbackCalls = 0;
    const snapshot = await getCurrentActivity(CLIENT, runtime({
      runActivity: async () => ({ stdout: 'unexpected machine output' }),
      readActivityTable: async () => ({ exists: true, modifiedAt: NOW - 1000 }),
      readFallback: async () => {
        fallbackCalls += 1;
        return {
          code: 'BD',
          name: '丛林症结',
          source: 'penguin',
          startTime: NOW - 1000,
          endTime: NOW + 60_000,
          stages: ['BD-1']
        };
      }
    }));

    assert.equal(fallbackCalls, 1);
    assert.equal(snapshot.status, 'active');
    assert.equal(snapshot.code, 'BD');
    assert.equal(snapshot.source, 'penguin');
  });

  it('uses the fallback source when the activity table is missing', async () => {
    const snapshot = await getCurrentActivity(CLIENT, runtime({
      runActivity: async () => ({ stdout: '' }),
      readActivityTable: async () => ({ exists: false, modifiedAt: null }),
      readFallback: async () => ({
        code: 'BD',
        name: '丛林症结',
        source: 'penguin',
        startTime: NOW - 1000,
        endTime: NOW + 60_000,
        stages: ['BD-1', 'BD-8']
      })
    }));

    assert.equal(snapshot.status, 'active');
    assert.equal(snapshot.code, 'BD');
    assert.equal(snapshot.source, 'penguin');
    assert.deepEqual(snapshot.stages, ['BD-1', 'BD-8']);
    assert.equal(snapshot.lastSuccessAt, NOW);
    assert.equal(snapshot.dataUpdatedAt, NOW);
    assert.equal(snapshot.failure, null);
  });

  it('reports none from a supported fallback source instead of unavailable', async () => {
    const snapshot = await getCurrentActivity(CLIENT, runtime({
      runActivity: async () => ({ stdout: '' }),
      readActivityTable: async () => ({ exists: false, modifiedAt: null }),
      readFallback: async () => null
    }));

    assert.equal(snapshot.status, 'none');
    assert.equal(snapshot.source, 'penguin');
    assert.equal(snapshot.code, null);
    assert.equal(snapshot.failure, null);
  });

  it('queries the fallback source when the activity table is older than one day', async () => {
    let fallbackCalls = 0;
    const snapshot = await getCurrentActivity(CLIENT, runtime({
      runActivity: async () => ({ stdout: MINI_GAMES_ONLY }),
      readActivityTable: async () => ({ exists: true, modifiedAt: NOW - ONE_DAY - 1 }),
      readFallback: async () => {
        fallbackCalls += 1;
        return {
          code: 'BD',
          name: '丛林症结',
          source: 'penguin',
          startTime: NOW - 1000,
          endTime: null,
          stages: ['BD-1']
        };
      }
    }));

    assert.equal(fallbackCalls, 1);
    assert.equal(snapshot.status, 'active');
    assert.equal(snapshot.code, 'BD');
  });

  it('degrades to stale with the last successful activity when every source fails', async () => {
    const entry = cachedActivity({ timestamp: NOW - 60 * 60 * 1000, ttl: ONE_DAY });
    const snapshot = await getCurrentActivity(CLIENT, runtime({
      cache: new Map([[CLIENT, entry]]),
      runActivity: async () => {
        throw new Error('MAA 超时');
      },
      readFallback: async () => {
        throw new Error('企鹅物流 503');
      }
    }));

    assert.equal(snapshot.status, 'stale');
    assert.equal(snapshot.code, 'YW');
    assert.equal(snapshot.name, '昨日海');
    assert.equal(snapshot.lastSuccessAt, entry.timestamp);
    assert.equal(snapshot.dataUpdatedAt, null);
    assert.equal(snapshot.failure?.source, 'maa');
    assert.match(snapshot.failure?.message ?? '', /MAA 活动查询失败: MAA 超时/);
    assert.match(snapshot.failure?.message ?? '', /备用活动数据源不可用: 企鹅物流 503/);
  });

  it('returns unavailable without mapping an unsupported client to another server', async () => {
    let fallbackCalls = 0;
    const snapshot = await getCurrentActivity('Txwy', runtime({
      runActivity: async () => {
        throw new Error('CLI 失败');
      },
      readFallback: async () => {
        fallbackCalls += 1;
        return {
          code: 'CN',
          name: '不应出现的国服活动',
          source: 'penguin',
          startTime: NOW,
          endTime: null,
          stages: []
        };
      },
      supportsFallback: () => false
    }));

    assert.equal(fallbackCalls, 0);
    assert.equal(snapshot.status, 'unavailable');
    assert.equal(snapshot.code, null);
    assert.equal(snapshot.name, null);
    assert.equal(snapshot.lastSuccessAt, null);
    assert.equal(snapshot.failure?.source, 'maa');
    assert.match(snapshot.failure?.message ?? '', /备用活动数据源不支持 Txwy/);
  });

  it('never reports an expired cache entry as active even with a long stored ttl', async () => {
    const entry = cachedActivity({
      timestamp: NOW - TEN_MINUTES - 1000,
      ttl: ONE_DAY
    });
    const snapshot = await getCurrentActivity(CLIENT, runtime({
      cache: new Map([[CLIENT, entry]]),
      runActivity: async () => ({ stdout: MINI_GAMES_ONLY }),
      readActivityTable: async () => ({ exists: true, modifiedAt: NOW - 1000 })
    }));

    assert.notEqual(snapshot.status, 'active');
    assert.equal(snapshot.status, 'none');
    assert.equal(snapshot.code, null);
  });

  it('keeps the read result when saving the activity cache fails', async () => {
    const snapshot = await getCurrentActivity(CLIENT, runtime({
      runActivity: async () => ({
        stdout: `Opening side story stages:
- SideStory「昨日海」
  - YW-8: 液化高能气体`
      }),
      saveConfig: async () => {
        throw new Error('磁盘只读');
      }
    }));

    assert.equal(snapshot.status, 'active');
    assert.equal(snapshot.code, 'YW');
  });

  it('merges other client entries and clamps persisted ttl when saving', async () => {
    const otherEntry = cachedActivity({ code: 'B', name: 'B服活动' });
    const saved: Record<string, unknown>[] = [];
    await getCurrentActivity(CLIENT, runtime({
      loadConfig: async () => ({ Bilibili: otherEntry }),
      runActivity: async () => ({
        stdout: `Opening side story stages:
- SideStory「昨日海」
  - YW-8: 液化高能气体`
      }),
      saveConfig: async payload => {
        saved.push(payload);
      }
    }));

    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0]?.Bilibili, otherEntry);
    assert.deepEqual(saved[0]?.[CLIENT], {
      code: 'YW',
      name: '昨日海',
      source: 'maa',
      startTime: null,
      endTime: null,
      stages: [],
      timestamp: NOW,
      ttl: TEN_MINUTES
    });
  });
});
