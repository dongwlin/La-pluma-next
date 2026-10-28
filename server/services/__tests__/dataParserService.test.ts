import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  getAllOperators,
  getDepotData,
  getOperBoxData,
  parseDepotData,
  parseOperBoxData
} from '../dataParserService.ts';
import type { DataParserPorts } from '../dataParserService.ts';
import type { ApiErrorResponse, ApiSuccessResponse } from '../../utils/apiHelper.ts';
import { loggerManager } from '../../utils/logger.ts';

loggerManager.getLogger('DataParser').enableConsole = false;

let rootDir: string;

before(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'la-pluma-data-parser-'));
});

after(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

function expectSuccess<T>(result: ApiSuccessResponse<T> | ApiErrorResponse | null): T {
  if (result === null) assert.fail('expected a success response, got null');
  if (!result.success) assert.fail(result.message);
  return result.data;
}

function expectError(result: ApiSuccessResponse<unknown> | ApiErrorResponse | null, message: string): void {
  if (result === null) assert.fail('expected an error response, got null');
  assert.equal(result.success, false);
  assert.equal(result.message, message);
}

interface Fixture {
  dir: string;
  ports: DataParserPorts;
  itemIndexPath: string;
  itemTablePath: string;
  battleDataPath: string;
  maaLogPath: string;
  dataDir: string;
}

/** 每个用例独立的临时目录：模块级缓存按路径保存，互不串味。 */
async function createFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(rootDir, 'case-'));
  const resourceDir = join(dir, 'resource');
  const dataDir = join(dir, 'data');
  await mkdir(resourceDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const itemIndexPath = join(resourceDir, 'item_index.json');
  const itemTablePath = join(resourceDir, 'gamedata', 'excel', 'item_table.json');
  const battleDataPath = join(resourceDir, 'battle_data.json');
  const maaLogPath = join(dir, 'asst.log');

  return {
    dir,
    itemIndexPath,
    itemTablePath,
    battleDataPath,
    maaLogPath,
    dataDir,
    ports: {
      itemIndexPath,
      itemTablePath,
      battleDataPath,
      maaLogPath,
      dataDir,
      // 默认禁止回源：任何用例误走网络都会得到明确失败而不是真实下载。
      fetchItemTable: async () => {
        throw new Error('unexpected outbound item table request');
      }
    }
  };
}

function depotLogLine(counts: Record<string, number>, done = true): string {
  const escaped = JSON.stringify(counts).replace(/"/g, '\\"');
  return `[2026-10-27 10:00:00] {"what": "DepotInfo", "details": {"done":${done}, "data": "${escaped}"}}`;
}

function operBoxLogLine(operators: Record<string, unknown>[], done = true): string {
  return `[2026-10-27 10:00:00] {"class":"OperBoxInfo","what":"OperBoxInfo","details":{"done":${done},"own_opers":${JSON.stringify(operators)}}}`;
}

async function writeItemFixture(fixture: Fixture): Promise<void> {
  await mkdir(join(fixture.dir, 'resource', 'gamedata', 'excel'), { recursive: true });
  await writeFile(fixture.itemIndexPath, JSON.stringify({
    30011: { name: '源岩', icon: '30011.png', classifyType: 'NORMAL', sortId: 10001 }
  }), 'utf-8');
  await writeFile(fixture.itemTablePath, JSON.stringify({
    items: { 30011: { iconId: 'ROCK', name: '源岩' } }
  }), 'utf-8');
}

describe('getAllOperators', () => {
  it('reads the MAA battle data, spells out known fields and sorts by rarity', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.battleDataPath, JSON.stringify({
      chars: {
        char_1001_amiya: { name: '阿米娅', rarity: 5, profession: 'CASTER', position: 'RANGED' },
        char_2002_kalts: { name: '凯尔希', rarity: 6, profession: 'HEALER' },
        char_501_temp: { name: '预备干员A', rarity: 4 },
        char_600_temp: { name: '预备干员B', rarity: 4 },
        token_1001: { name: '召唤物', rarity: 1 },
        char_3003_broken: { rarity: 3 }
      }
    }), 'utf-8');

    const operators = await getAllOperators(fixture.ports);

    assert.deepEqual(operators, [
      { id: 'char_2002_kalts', name: '凯尔希', rarity: 6, profession: 'HEALER' },
      { id: 'char_1001_amiya', name: '阿米娅', rarity: 5, profession: 'CASTER', position: 'RANGED' }
    ]);
  });

  it('reports a missing battle data file as unreadable operator data', async () => {
    const fixture = await createFixture();

    await assert.rejects(() => getAllOperators(fixture.ports), /无法读取干员数据/);
  });

  it('reports battle data without a chars map as unreadable operator data', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.battleDataPath, JSON.stringify({ chars: [] }), 'utf-8');

    await assert.rejects(() => getAllOperators(fixture.ports), /无法读取干员数据/);
  });
});

describe('getDepotData / getOperBoxData', () => {
  it('returns null when the recognition cache has not been written', async () => {
    const fixture = await createFixture();

    assert.equal(await getDepotData(fixture.ports), null);
    assert.equal(await getOperBoxData(fixture.ports), null);
  });

  it('reads the saved depot cache', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.dataDir, 'depot.json'), JSON.stringify({
      timestamp: '2026-10-27T00:00:00.000Z',
      itemCount: 1,
      items: [{ id: '30011', name: '源岩', count: 5, icon: '30011.png', iconId: 'ROCK', classifyType: 'NORMAL', sortId: 10001 }]
    }), 'utf-8');

    const depot = await getDepotData(fixture.ports);

    assert.equal(depot?.itemCount, 1);
    assert.equal(depot?.items[0].name, '源岩');
    assert.equal(depot?.items[0].iconId, 'ROCK');
  });

  it('keeps operator entries opaque when reading the saved operbox cache', async () => {
    const fixture = await createFixture();
    const entry = { id: 'char_1001_amiya', name: '阿米娅', rarity: 5, elite: 0, level: 1, potential: 6, own: true };
    await writeFile(join(fixture.dataDir, 'operbox.json'), JSON.stringify({
      timestamp: '2026-10-27T00:00:00.000Z',
      operCount: 1,
      data: [entry]
    }), 'utf-8');

    const operBox = await getOperBoxData(fixture.ports);

    assert.equal(operBox?.operCount, 1);
    assert.deepEqual(operBox?.data[0], entry);
  });

  it('treats caches with an unexpected shape as missing instead of returning them', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.dataDir, 'depot.json'), JSON.stringify({ items: 'not-a-list' }), 'utf-8');
    await writeFile(join(fixture.dataDir, 'operbox.json'), JSON.stringify([1, 2, 3]), 'utf-8');

    assert.equal(await getDepotData(fixture.ports), null);
    assert.equal(await getOperBoxData(fixture.ports), null);
  });
});

describe('parseDepotData', () => {
  it('enriches depot entries from the local index and item table, then writes the cache', async () => {
    const fixture = await createFixture();
    await writeItemFixture(fixture);
    await writeFile(fixture.maaLogPath, [
      depotLogLine({ 30011: 5, 99999: 2 }),
      'unrelated log line'
    ].join('\n'), 'utf-8');

    const result = expectSuccess(await parseDepotData(fixture.ports));

    assert.equal(result.itemCount, 2);
    assert.deepEqual(result.items.map(item => item.id), ['30011', '99999']);
    assert.deepEqual(result.items[0], {
      id: '30011',
      name: '源岩',
      count: 5,
      icon: '30011.png',
      iconId: 'ROCK',
      classifyType: 'NORMAL',
      sortId: 10001
    });
    assert.equal(result.items[1].name, '未知物品 (99999)');
    assert.equal(result.items[1].classifyType, 'UNKNOWN');
    assert.equal(result.items[1].iconId, undefined);

    const saved = JSON.parse(await readFile(join(fixture.dataDir, 'depot.json'), 'utf-8'));
    assert.deepEqual(saved.items, result.items);
  });

  it('prefers the last completed DepotInfo payload', async () => {
    const fixture = await createFixture();
    await writeItemFixture(fixture);
    await writeFile(fixture.maaLogPath, [
      depotLogLine({ 30011: 3 }, true),
      depotLogLine({ 30011: 9 }, false)
    ].join('\n'), 'utf-8');

    const result = expectSuccess(await parseDepotData(fixture.ports));

    assert.equal(result.items[0].count, 3);
  });

  it('returns null when the log has no DepotInfo payload', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.maaLogPath, 'no recognition data here', 'utf-8');

    assert.equal(await parseDepotData(fixture.ports), null);
  });

  it('fails the recognition when the DepotInfo payload is not a count map', async () => {
    const fixture = await createFixture();
    await writeItemFixture(fixture);
    const escaped = JSON.stringify({ 30011: 'five' }).replace(/"/g, '\\"');
    await writeFile(fixture.maaLogPath, `{"what": "DepotInfo", "details": {"done": true, "data": "${escaped}"}}`, 'utf-8');

    expectError(await parseDepotData(fixture.ports), '解析仓库数据失败');
  });

  it('falls back to the outbound port when the item table is missing and caches the result', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.itemIndexPath, JSON.stringify({
      30011: { name: '源岩', icon: '30011.png', classifyType: 'NORMAL', sortId: 10001 }
    }), 'utf-8');
    await writeFile(fixture.maaLogPath, depotLogLine({ 30011: 1 }), 'utf-8');

    let fetchCount = 0;
    const ports: DataParserPorts = {
      ...fixture.ports,
      fetchItemTable: async () => {
        fetchCount += 1;
        return { items: { 30011: { iconId: 'FETCHED' } } };
      }
    };

    const first = expectSuccess(await parseDepotData(ports));
    assert.equal(first.items[0].iconId, 'FETCHED');
    assert.equal(fetchCount, 1);

    const downloaded = JSON.parse(await readFile(fixture.itemTablePath, 'utf-8'));
    assert.deepEqual(downloaded, { items: { 30011: { iconId: 'FETCHED' } } });

    const second = expectSuccess(await parseDepotData(ports));
    assert.equal(second.items[0].iconId, 'FETCHED');
    assert.equal(fetchCount, 1, 'the downloaded item table is cached for later recognitions');
  });

  it('keeps cached index data for a path after the file changes on disk', async () => {
    const fixture = await createFixture();
    await writeItemFixture(fixture);
    await writeFile(fixture.maaLogPath, depotLogLine({ 30011: 1 }), 'utf-8');

    const first = expectSuccess(await parseDepotData(fixture.ports));
    assert.equal(first.items[0].name, '源岩');

    await writeFile(fixture.itemIndexPath, JSON.stringify({
      30011: { name: '改名后的源岩', icon: '30011.png', classifyType: 'NORMAL', sortId: 10001 }
    }), 'utf-8');

    const cached = expectSuccess(await parseDepotData(fixture.ports));
    assert.equal(cached.items[0].name, '源岩', 'the per-path index cache is reused within one process');

    // 另一路径不复用上面的缓存：新路径读取自己的索引。
    const other = await createFixture();
    await writeFile(other.itemIndexPath, JSON.stringify({
      30011: { name: '另一份索引', icon: '30011.png', classifyType: 'NORMAL', sortId: 10001 }
    }), 'utf-8');
    await mkdir(join(other.dir, 'resource', 'gamedata', 'excel'), { recursive: true });
    await writeFile(other.itemTablePath, JSON.stringify({ items: { 30011: { iconId: 'ROCK' } } }), 'utf-8');
    await writeFile(other.maaLogPath, depotLogLine({ 30011: 1 }), 'utf-8');

    const reloaded = expectSuccess(await parseDepotData(other.ports));
    assert.equal(reloaded.items[0].name, '另一份索引');
  });

  it('keeps the recognition cache untouched when the log file is missing', async () => {
    const fixture = await createFixture();
    await writeItemFixture(fixture);

    expectError(await parseDepotData(fixture.ports), '解析仓库数据失败');
    assert.equal(await getDepotData(fixture.ports), null);
  });
});

describe('parseOperBoxData', () => {
  it('stores the identified operator list', async () => {
    const fixture = await createFixture();
    const operators = [
      { id: 'char_1001_amiya', name: '阿米娅', rarity: 5, elite: 0, level: 1, potential: 6, own: true }
    ];
    await writeFile(fixture.maaLogPath, operBoxLogLine(operators), 'utf-8');

    const result = expectSuccess(await parseOperBoxData(fixture.ports));

    assert.equal(result.operCount, 1);
    assert.deepEqual(result.data, operators);

    const saved = JSON.parse(await readFile(join(fixture.dataDir, 'operbox.json'), 'utf-8'));
    assert.deepEqual(saved.data, operators);
  });

  it('keeps partial results and still records them', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.maaLogPath, operBoxLogLine([{ id: 'char_1001_amiya', name: '阿米娅' }], false), 'utf-8');

    const result = expectSuccess(await parseOperBoxData(fixture.ports));

    assert.equal(result.operCount, 1);
  });

  it('returns null when the log has no OperBoxInfo payload', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.maaLogPath, 'no operator data here', 'utf-8');

    assert.equal(await parseOperBoxData(fixture.ports), null);
  });

  it('fails the recognition when own_opers is not a list', async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.maaLogPath,
      '{"class":"OperBoxInfo","what":"OperBoxInfo","details":{"done":true,"own_opers":{"a":1}}}',
      'utf-8'
    );

    expectError(await parseOperBoxData(fixture.ports), '解析干员数据失败');
  });
});
