import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import type { ApiErrorResponse, ApiSuccessResponse } from '../../utils/apiHelper.ts';

// 掉落记录目录在模块导入时解析；先注入临时目录再导入被测模块，
// 避免测试触碰真实运行数据。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-drop-bounds-'));
process.env.LA_PLUMA_DROP_RECORDS_DIR = fixtureDir;

const {
  getRecentDrops,
  getDropStatistics,
  getTodayDrops,
  recordDrops,
  parseDropRecordDay,
  getLocalDateString,
  MAX_DROP_HISTORY_DAYS
} = await import('../dropRecordService.ts');
const { loggerManager } = await import('../../utils/logger.ts');
loggerManager.getLogger('DropRecord').enableConsole = false;

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

function expectSuccess<T>(result: ApiSuccessResponse<T> | ApiErrorResponse): T {
  if (!result.success) assert.fail(result.message);
  return result.data;
}

function createEmptyRecord(date: string) {
  return {
    date,
    records: [],
    summary: { totalSanity: 0, totalMedicine: 0, totalStone: 0, totalBattles: 0, itemsSummary: {} }
  };
}

async function writeDay(dateStr: string, payload: unknown): Promise<void> {
  await writeFile(join(fixtureDir, `${dateStr}.json`), JSON.stringify(payload), 'utf-8');
}

async function seedRecentDays(dayOffsets: number[]): Promise<void> {
  for (const offset of dayOffsets) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    const dateStr = getLocalDateString(date);
    await writeDay(dateStr, createEmptyRecord(dateStr));
  }
}

function dateDaysAgo(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() - offset);
  return getLocalDateString(date);
}

async function clearFixtureDir(): Promise<void> {
  const entries = await readdir(fixtureDir).catch(() => []);
  for (const entry of entries) {
    await rm(join(fixtureDir, entry), { recursive: true, force: true });
  }
}

describe('getRecentDrops numeric bounds', () => {
  beforeEach(clearFixtureDir);

  it('reads the default 7-day window for omitted, invalid and repeated input', async () => {
    await seedRecentDays([0, 1, 3]);
    const seededDates = [dateDaysAgo(0), dateDaysAgo(1), dateDaysAgo(3)];
    for (const days of [undefined, 'abc', Number.NaN, ['7', '9']]) {
      const records = expectSuccess(await getRecentDrops(days));
      assert.deepEqual(records.map(record => record.date), seededDates);
    }
  });

  it('limits the history window to the requested integer days', async () => {
    await seedRecentDays([0, 1, 3]);
    assert.deepEqual(
      expectSuccess(await getRecentDrops(2)).map(record => record.date),
      [dateDaysAgo(0), dateDaysAgo(1)]
    );
    assert.deepEqual(
      expectSuccess(await getRecentDrops(2.9)).map(record => record.date),
      [dateDaysAgo(0), dateDaysAgo(1)]
    );
  });

  it('clamps negatives and zero to a single day', async () => {
    await seedRecentDays([0]);
    for (const days of [-5, 0]) {
      assert.deepEqual(
        expectSuccess(await getRecentDrops(days)).map(record => record.date),
        [dateDaysAgo(0)]
      );
    }
  });

  it('bounds Infinity and oversized day counts instead of looping unbounded', async () => {
    await seedRecentDays([0, 1, 3]);
    for (const days of [Infinity, '1e9', 100000, '1e21']) {
      const records = expectSuccess(await getRecentDrops(days));
      assert.equal(records.length, 3);
      assert.ok(records.length <= MAX_DROP_HISTORY_DAYS);
    }
  });
});

describe('getDropStatistics numeric bounds', () => {
  beforeEach(clearFixtureDir);

  it('bounds the aggregated window for illegal and oversized input', async () => {
    await seedRecentDays([0, 1, 3]);
    for (const days of ['abc', Number.NaN, Infinity, '1e9']) {
      const statistics = expectSuccess(await getDropStatistics(days));
      assert.equal(statistics.dateRange.days, 3);
      assert.equal(statistics.dailyTrend.length, 3);
    }
  });
});

describe('recordDrops', () => {
  beforeEach(clearFixtureDir);

  it('keeps every concurrent record and its running summary', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => recordDrops({
        stage: '1-7',
        times: 1,
        sanity: 6,
        items: [{ name: '源岩', count: 2 }],
        source: 'fight',
        mode: 'normal'
      }))
    );
    for (const result of results) expectSuccess(result);

    const [today] = expectSuccess(await getRecentDrops(1));
    assert.equal(today.records.length, 12);
    assert.equal(today.summary.totalBattles, 12);
    assert.equal(today.summary.totalSanity, 72);
    assert.equal(today.summary.itemsSummary['源岩'], 24);
  });

  it('refuses to overwrite a record file it cannot parse', async () => {
    const todayPath = join(fixtureDir, `${dateDaysAgo(0)}.json`);
    const corrupted = JSON.stringify({ records: [] });
    await writeFile(todayPath, corrupted, 'utf-8');

    const result = await recordDrops({ stage: '1-7', times: 1 });

    assert.equal(result.success, false);
    assert.equal(result.message, '记录掉落失败');
    assert.equal(await readFile(todayPath, 'utf-8'), corrupted);
  });
});

describe('drop history parsing', () => {
  beforeEach(clearFixtureDir);

  it('reads records written before source and mode were added', async () => {
    const date = dateDaysAgo(0);
    await writeDay(date, {
      date,
      records: [{
        timestamp: '2026-10-23T01:40:38.710Z',
        stage: '1-7',
        times: 2,
        sanity: 12,
        medicine: 0,
        stone: 0,
        items: [{ name: '源岩', count: 3 }]
      }],
      summary: { totalSanity: 12, totalMedicine: 0, totalStone: 0, totalBattles: 2, itemsSummary: { 源岩: 3 } }
    });

    const [today] = expectSuccess(await getRecentDrops(1));

    assert.equal(today.records[0].source, 'fight');
    assert.equal(today.records[0].mode, 'normal');
    assert.equal(today.summary.itemsSummary['源岩'], 3);
  });

  it('skips a day file whose shape is not a record and keeps other days readable', async () => {
    await writeDay(dateDaysAgo(0), { records: [] });
    await writeDay(dateDaysAgo(1), createEmptyRecord(dateDaysAgo(1)));

    const records = expectSuccess(await getRecentDrops(2));
    assert.deepEqual(records.map(record => record.date), [dateDaysAgo(1)]);

    const statistics = expectSuccess(await getDropStatistics(2));
    assert.equal(statistics.dateRange.days, 1);
  });

  it('returns an empty record for a missing today file', async () => {
    const today = expectSuccess(await getTodayDrops());

    assert.equal(today.date, dateDaysAgo(0));
    assert.deepEqual(today.records, []);
    assert.equal(today.summary.totalBattles, 0);
  });
});

describe('drop statistics material table', () => {
  beforeEach(clearFixtureDir);

  async function seedOneDayWithItem(): Promise<void> {
    const date = dateDaysAgo(0);
    await writeDay(date, {
      date,
      records: [{
        timestamp: '2026-10-27T01:00:00.000Z',
        stage: '1-7',
        times: 1,
        sanity: 6,
        medicine: 0,
        stone: 0,
        items: [{ name: '源岩', count: 2 }],
        source: 'fight',
        mode: 'normal'
      }],
      summary: { totalSanity: 6, totalMedicine: 0, totalStone: 0, totalBattles: 1, itemsSummary: { 源岩: 2 } }
    });
  }

  it('enriches items from an array-format material table', async () => {
    await seedOneDayWithItem();
    const materialsPath = join(fixtureDir, 'materials-array.json');
    await writeFile(materialsPath, JSON.stringify([{ name: '源岩', iconId: '30012', rarity: 3 }]), 'utf-8');

    const statistics = expectSuccess(await getDropStatistics(1, { materialsPath }));

    assert.equal(statistics.items['源岩'].count, 2);
    assert.equal(statistics.items['源岩'].iconId, '30012');
    assert.equal(statistics.items['源岩'].rarity, 3);
  });

  it('keeps null icons for the object-format material table used by the fetch scripts', async () => {
    await seedOneDayWithItem();
    const materialsPath = join(fixtureDir, 'materials-object.json');
    await writeFile(materialsPath, JSON.stringify({ materials: {}, recipes: {} }), 'utf-8');

    const statistics = expectSuccess(await getDropStatistics(1, { materialsPath }));

    assert.equal(statistics.items['源岩'].iconId, null);
    assert.equal(statistics.items['源岩'].rarity, null);
  });
});

describe('parseDropRecordDay', () => {
  it('normalizes legacy records but rejects missing totals', () => {
    const parsed = parseDropRecordDay({
      date: '2026-10-23',
      records: [],
      summary: { totalSanity: 0, totalMedicine: 0, totalStone: 0, totalBattles: 0, itemsSummary: {} }
    });
    assert.deepEqual(parsed, {
      date: '2026-10-23',
      records: [],
      summary: { totalSanity: 0, totalMedicine: 0, totalStone: 0, totalBattles: 0, itemsSummary: {} }
    });

    assert.equal(parseDropRecordDay({ date: '2026-10-23', records: [], summary: { totalSanity: 0 } }), null);
    assert.equal(parseDropRecordDay({ records: [], summary: {} }), null);
    assert.equal(parseDropRecordDay('2026-10-23'), null);
  });
});
