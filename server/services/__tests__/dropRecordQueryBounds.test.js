import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

// 掉落记录目录在模块导入时解析；先注入临时目录再导入被测模块，
// 避免测试触碰真实运行数据。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-drop-bounds-'));
process.env.LA_PLUMA_DROP_RECORDS_DIR = fixtureDir;

const { getRecentDrops, getDropStatistics, getLocalDateString, MAX_DROP_HISTORY_DAYS } = await import('../dropRecordService.js');

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

function createRecord(date) {
  return {
    date,
    records: [],
    summary: { totalSanity: 0, totalMedicine: 0, totalStone: 0, totalBattles: 0, itemsSummary: {} }
  };
}

async function seedRecentDays(dayOffsets) {
  for (const offset of dayOffsets) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    const dateStr = getLocalDateString(date);
    await writeFile(join(fixtureDir, `${dateStr}.json`), JSON.stringify(createRecord(dateStr)), 'utf-8');
  }
}

function dateDaysAgo(offset) {
  const date = new Date();
  date.setDate(date.getDate() - offset);
  return getLocalDateString(date);
}

describe('getRecentDrops numeric bounds', () => {
  beforeEach(async () => {
    const entries = await readdir(fixtureDir).catch(() => []);
    for (const entry of entries) {
      await rm(join(fixtureDir, entry), { recursive: true, force: true });
    }
  });

  it('reads the default 7-day window for omitted, invalid and repeated input', async () => {
    await seedRecentDays([0, 1, 3]);
    const seededDates = [dateDaysAgo(0), dateDaysAgo(1), dateDaysAgo(3)];
    for (const days of [undefined, 'abc', Number.NaN, ['7', '9']]) {
      const result = await getRecentDrops(days);
      assert.equal(result.success, true);
      assert.deepEqual(result.data.map(record => record.date), seededDates);
    }
  });

  it('limits the history window to the requested integer days', async () => {
    await seedRecentDays([0, 1, 3]);
    const twoDays = await getRecentDrops(2);
    assert.deepEqual(twoDays.data.map(record => record.date), [dateDaysAgo(0), dateDaysAgo(1)]);

    const truncated = await getRecentDrops(2.9);
    assert.deepEqual(truncated.data.map(record => record.date), [dateDaysAgo(0), dateDaysAgo(1)]);
  });

  it('clamps negatives and zero to a single day', async () => {
    await seedRecentDays([0]);
    for (const days of [-5, 0]) {
      const result = await getRecentDrops(days);
      assert.deepEqual(result.data.map(record => record.date), [dateDaysAgo(0)]);
    }
  });

  it('bounds Infinity and oversized day counts instead of looping unbounded', async () => {
    await seedRecentDays([0, 1, 3]);
    for (const days of [Infinity, '1e9', 100000, '1e21']) {
      const result = await getRecentDrops(days);
      assert.equal(result.success, true);
      assert.equal(result.data.length, 3);
      assert.ok(result.data.length <= MAX_DROP_HISTORY_DAYS);
    }
  });

  it('keeps valid in-range requests untouched', async () => {
    await seedRecentDays([5]);
    const result = await getRecentDrops(30);
    assert.deepEqual(result.data.map(record => record.date), [dateDaysAgo(5)]);
  });
});

describe('getDropStatistics numeric bounds', () => {
  beforeEach(async () => {
    const entries = await readdir(fixtureDir).catch(() => []);
    for (const entry of entries) {
      await rm(join(fixtureDir, entry), { recursive: true, force: true });
    }
  });

  it('bounds the aggregated window for illegal and oversized input', async () => {
    await seedRecentDays([0, 1, 3]);
    for (const days of ['abc', Number.NaN, Infinity, '1e9']) {
      const result = await getDropStatistics(days);
      assert.equal(result.success, true);
      assert.equal(result.data.dateRange.days, 3);
      assert.equal(result.data.dailyTrend.length, 3);
    }
  });

  it('keeps the default window for omitted input', async () => {
    await seedRecentDays([0, 1, 3]);
    const result = await getDropStatistics();
    assert.equal(result.success, true);
    assert.equal(result.data.dateRange.days, 3);
  });
});
