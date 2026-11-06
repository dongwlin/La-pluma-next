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

const CALLBACK_PREFIX = '[2026-10-27 10:00:00.000][INF][Px1][Tx1] Assistant::append_callback | ';

/** MaaCore 按字段名字典序序列化：`class`、`details`、`subtask`、`taskchain` 在前，`what` 在最后。 */
function callbackLine(event: string, payload: Record<string, unknown>): string {
  return `${CALLBACK_PREFIX}${event} ${JSON.stringify(payload)}`;
}

function depotTaskLine(event: 'TaskChainStart' | 'TaskChainCompleted' | 'TaskChainError'): string {
  return callbackLine(event, { taskchain: 'Depot', taskid: 1, uuid: 'fixture' });
}

function operBoxTaskLine(event: 'TaskChainStart' | 'TaskChainCompleted' | 'TaskChainError'): string {
  return callbackLine(event, { taskchain: 'OperBox', taskid: 1, uuid: 'fixture' });
}

function depotInfoLine(counts: Record<string, unknown>, done = true): string {
  return callbackLine('SubTaskExtraInfo', {
    class: 'asst::DepotRecognitionTask',
    details: { data: JSON.stringify(counts), done },
    subtask: 'DepotRecognitionTask',
    taskchain: 'Depot',
    taskid: 1,
    uuid: 'fixture',
    what: 'DepotInfo'
  });
}

function operBoxInfoLine(
  operators: Record<string, unknown>[],
  done = true,
  allOpers?: Record<string, unknown>[]
): string {
  return callbackLine('SubTaskExtraInfo', {
    class: 'asst::OperBoxRecognitionTask',
    details: allOpers === undefined ? { done, own_opers: operators } : { done, own_opers: operators, all_opers: allOpers },
    subtask: 'OperBoxRecognitionTask',
    taskchain: 'OperBox',
    taskid: 1,
    uuid: 'fixture',
    what: 'OperBoxInfo'
  });
}

function depotRun(counts: Record<string, unknown>, done = true): string[] {
  return [
    depotTaskLine('TaskChainStart'),
    depotInfoLine(counts, done),
    ...(done ? [depotTaskLine('TaskChainCompleted')] : [])
  ];
}

function operBoxRun(
  operators: Record<string, unknown>[],
  done = true,
  allOpers?: Record<string, unknown>[]
): string[] {
  return [
    operBoxTaskLine('TaskChainStart'),
    operBoxInfoLine(operators, done, allOpers),
    ...(done ? [operBoxTaskLine('TaskChainCompleted')] : [])
  ];
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
    // 旧快照没有识别目录，只能确认已识别拥有，未列出的干员按未确认上报。
    assert.deepEqual(operBox?.recognition, { status: 'partial', total: 1, owned: 1 });
    assert.equal(operBox?.allOpers, undefined);
  });

  it('reads a snapshot with the recognition catalog and reports complete recognition', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.dataDir, 'operbox.json'), JSON.stringify({
      timestamp: '2026-10-27T00:00:00.000Z',
      operCount: 1,
      data: [{ id: 'char_1001_amiya', name: '阿米娅', rarity: 5 }],
      allOpers: [
        { id: 'char_1001_amiya', name: '阿米娅', names: { en: 'Amiya' }, rarity: 5, owned: true },
        { id: 'char_2002_kalts', name: '凯尔希', rarity: 6, owned: false }
      ],
      operTotal: 2
    }), 'utf-8');

    const operBox = await getOperBoxData(fixture.ports);

    assert.deepEqual(operBox?.recognition, { status: 'complete', total: 2, owned: 1 });
    assert.deepEqual(operBox?.allOpers?.map(operator => [operator.id, operator.owned]), [
      ['char_1001_amiya', true],
      ['char_2002_kalts', false]
    ]);
    assert.deepEqual(operBox?.allOpers?.[0].names, { en: 'Amiya' });
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
      ...depotRun({ 30011: 5, 99999: 2 }),
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

  it('parses the real MaaCore field order where details precedes what', async () => {
    const fixture = await createFixture();
    await writeItemFixture(fixture);
    await writeFile(fixture.maaLogPath, depotInfoLine({ 30011: 5 }), 'utf-8');

    const result = expectSuccess(await parseDepotData(fixture.ports));

    assert.equal(result.items[0].count, 5);
  });

  it('parses a legacy bare payload line without a callback prefix or taskchain', async () => {
    const fixture = await createFixture();
    await writeItemFixture(fixture);
    await writeFile(fixture.maaLogPath, JSON.stringify({
      what: 'DepotInfo',
      details: { data: JSON.stringify({ 30011: 5 }), done: true }
    }), 'utf-8');

    const result = expectSuccess(await parseDepotData(fixture.ports));

    assert.equal(result.items[0].count, 5);
  });

  it('does not pair a DepotInfo event with data from a later callback', async () => {
    const fixture = await createFixture();
    await writeItemFixture(fixture);
    const unrelated = callbackLine('SubTaskExtraInfo', {
      class: 'asst::StageDropsTask',
      details: { data: JSON.stringify({ 30011: 99 }), done: true },
      subtask: 'Fight',
      taskchain: 'Fight',
      taskid: 2,
      uuid: 'fixture',
      what: 'StageDrops'
    });
    await writeFile(fixture.maaLogPath, [
      ...depotRun({ 30011: 5 }),
      unrelated
    ].join('\n'), 'utf-8');

    const result = expectSuccess(await parseDepotData(fixture.ports));

    assert.equal(result.items[0].count, 5);
  });

  it('uses only the latest recognition run and keeps the previous cache when that run is incomplete', async () => {
    const fixture = await createFixture();
    await writeItemFixture(fixture);
    const previous = {
      timestamp: '2026-10-26T00:00:00.000Z',
      itemCount: 1,
      items: [{ id: '30011', name: '源岩', count: 1, icon: '30011.png', iconId: 'ROCK', classifyType: 'NORMAL', sortId: 10001 }]
    };
    await writeFile(join(fixture.dataDir, 'depot.json'), JSON.stringify(previous), 'utf-8');
    await writeFile(fixture.maaLogPath, [
      ...depotRun({ 30011: 3 }),
      ...depotRun({ 30011: 9 }, false)
    ].join('\n'), 'utf-8');

    expectError(await parseDepotData(fixture.ports), '解析仓库数据失败');

    const cached = await getDepotData(fixture.ports);
    assert.deepEqual(cached, previous);
  });

  it('keeps the last completed payload when a partial update follows in the same run', async () => {
    const fixture = await createFixture();
    await writeItemFixture(fixture);
    await writeFile(fixture.maaLogPath, [
      depotTaskLine('TaskChainStart'),
      depotInfoLine({ 30011: 3 }, true),
      depotInfoLine({ 30011: 9 }, false)
    ].join('\n'), 'utf-8');

    const result = expectSuccess(await parseDepotData(fixture.ports));

    assert.equal(result.items[0].count, 3);
  });

  it('does not fall back to a completed run after a later truncated run fragment', async () => {
    const fixture = await createFixture();
    await writeItemFixture(fixture);
    const previous = {
      timestamp: '2026-10-26T00:00:00.000Z',
      itemCount: 1,
      items: [{ id: '30011', name: '源岩', count: 1, icon: '30011.png', iconId: 'ROCK', classifyType: 'NORMAL', sortId: 10001 }]
    };
    await writeFile(join(fixture.dataDir, 'depot.json'), JSON.stringify(previous), 'utf-8');
    await writeFile(fixture.maaLogPath, [
      ...depotRun({ 30011: 3 }),
      depotInfoLine({ 30011: 9 }, false)
    ].join('\n'), 'utf-8');

    expectError(await parseDepotData(fixture.ports), '解析仓库数据失败');

    assert.deepEqual(await getDepotData(fixture.ports), previous);
  });

  it('returns null instead of the previous run when the latest run has no payload yet', async () => {
    const fixture = await createFixture();
    await writeItemFixture(fixture);
    await writeFile(fixture.maaLogPath, [
      ...depotRun({ 30011: 3 }),
      depotTaskLine('TaskChainStart')
    ].join('\n'), 'utf-8');

    assert.equal(await parseDepotData(fixture.ports), null);
    assert.equal(await getDepotData(fixture.ports), null);
  });

  it('takes the last payload after progress and assistant completion callbacks', async () => {
    const fixture = await createFixture();
    await writeItemFixture(fixture);
    await writeFile(fixture.maaLogPath, [
      depotTaskLine('TaskChainStart'),
      depotInfoLine({ 30011: 3 }, false),
      depotInfoLine({ 30011: 9 }, true),
      callbackLine('SubTaskCompleted', { subtask: 'DepotRecognitionTask', taskchain: 'Depot', taskid: 1, uuid: 'fixture' }),
      depotTaskLine('TaskChainCompleted'),
      callbackLine('AllTasksCompleted', { finished_tasks: [1], taskchain: 'Depot', taskid: 1, uuid: 'fixture' })
    ].join('\n'), 'utf-8');

    const result = expectSuccess(await parseDepotData(fixture.ports));

    assert.equal(result.items[0].count, 9);
  });

  it('returns null when the log has no DepotInfo payload', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.maaLogPath, 'no recognition data here', 'utf-8');

    assert.equal(await parseDepotData(fixture.ports), null);
  });

  it('fails the recognition when the DepotInfo payload is not a count map', async () => {
    const fixture = await createFixture();
    await writeItemFixture(fixture);
    await writeFile(fixture.maaLogPath, depotInfoLine({ 30011: 'five' }), 'utf-8');

    expectError(await parseDepotData(fixture.ports), '解析仓库数据失败');
  });

  it('falls back to the outbound port when the item table is missing and caches the result', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.itemIndexPath, JSON.stringify({
      30011: { name: '源岩', icon: '30011.png', classifyType: 'NORMAL', sortId: 10001 }
    }), 'utf-8');
    await writeFile(fixture.maaLogPath, depotRun({ 30011: 1 }).join('\n'), 'utf-8');

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

  it('re-reads cached index data when the file changes on disk', async () => {
    const fixture = await createFixture();
    await writeItemFixture(fixture);
    await writeFile(fixture.maaLogPath, depotRun({ 30011: 1 }).join('\n'), 'utf-8');

    const first = expectSuccess(await parseDepotData(fixture.ports));
    assert.equal(first.items[0].name, '源岩');

    await writeFile(fixture.itemIndexPath, JSON.stringify({
      30011: { name: '改名后的源岩', icon: '30011.png', classifyType: 'NORMAL', sortId: 10001 }
    }), 'utf-8');

    const reloaded = expectSuccess(await parseDepotData(fixture.ports));
    assert.equal(reloaded.items[0].name, '改名后的源岩', 'the file signature invalidates the cached index');

    const other = await createFixture();
    await writeFile(other.itemIndexPath, JSON.stringify({
      30011: { name: '另一份索引', icon: '30011.png', classifyType: 'NORMAL', sortId: 10001 }
    }), 'utf-8');
    await mkdir(join(other.dir, 'resource', 'gamedata', 'excel'), { recursive: true });
    await writeFile(other.itemTablePath, JSON.stringify({ items: { 30011: { iconId: 'ROCK' } } }), 'utf-8');
    await writeFile(other.maaLogPath, depotRun({ 30011: 1 }).join('\n'), 'utf-8');

    const fromOtherPath = expectSuccess(await parseDepotData(other.ports));
    assert.equal(fromOtherPath.items[0].name, '另一份索引');
  });

  it('keeps the recognition cache untouched when the log file is missing', async () => {
    const fixture = await createFixture();
    await writeItemFixture(fixture);

    expectError(await parseDepotData(fixture.ports), '解析仓库数据失败');
    assert.equal(await getDepotData(fixture.ports), null);
  });
});

describe('parseOperBoxData', () => {
  it('stores the identified operator list without a catalog and keeps partial recognition', async () => {
    const fixture = await createFixture();
    const operators = [
      { id: 'char_1001_amiya', name: '阿米娅', rarity: 5, elite: 0, level: 1, potential: 6, own: true }
    ];
    await writeFile(fixture.maaLogPath, [
      operBoxTaskLine('TaskChainStart'),
      operBoxInfoLine(operators, false),
      operBoxInfoLine(operators),
      callbackLine('SubTaskCompleted', { subtask: 'OperBoxRecognitionTask', taskchain: 'OperBox', taskid: 1, uuid: 'fixture' }),
      operBoxTaskLine('TaskChainCompleted'),
      callbackLine('AllTasksCompleted', { finished_tasks: [1], taskchain: 'OperBox', taskid: 1, uuid: 'fixture' })
    ].join('\n'), 'utf-8');

    const result = expectSuccess(await parseOperBoxData(fixture.ports));

    assert.equal(result.operCount, 1);
    assert.equal(result.operTotal, 1);
    assert.deepEqual(result.data, operators);
    assert.deepEqual(result.allOpers, []);
    assert.deepEqual(result.recognition, { status: 'partial', total: 1, owned: 1 });

    const saved = JSON.parse(await readFile(join(fixture.dataDir, 'operbox.json'), 'utf-8'));
    assert.deepEqual(saved.data, operators);
    assert.equal(saved.recognition.status, 'partial');
    assert.equal(saved.allOpers, undefined);
  });

  it('persists the all_opers catalog with ownership markers and localized names', async () => {
    const fixture = await createFixture();
    const operators = [
      { id: 'char_1001_amiya', name: '阿米娅', rarity: 5, elite: 2, level: 90, potential: 6, own: true }
    ];
    const catalog = [
      { id: 'char_1001_amiya', name: '阿米娅', name_en: 'Amiya', name_jp: 'アーミヤ', name_kr: '아미야', name_tw: '阿米婭', rarity: 5, own: true },
      { id: 'char_2002_kalts', name: '凯尔希', rarity: 6, own: false }
    ];
    await writeFile(fixture.maaLogPath, operBoxRun(operators, true, catalog).join('\n'), 'utf-8');

    const result = expectSuccess(await parseOperBoxData(fixture.ports));

    assert.equal(result.operTotal, 2);
    assert.deepEqual(result.recognition, { status: 'complete', total: 2, owned: 1 });
    assert.deepEqual(result.allOpers?.map(operator => [operator.id, operator.owned]), [
      ['char_1001_amiya', true],
      ['char_2002_kalts', false]
    ]);
    // 缺失语种不补空值；只保留载荷里实际出现过的名称。
    assert.deepEqual(result.allOpers?.[1].names, undefined);

    const saved = JSON.parse(await readFile(join(fixture.dataDir, 'operbox.json'), 'utf-8'));
    assert.equal(saved.operTotal, 2);
    assert.deepEqual(saved.recognition, { status: 'complete', total: 2, owned: 1 });
    assert.deepEqual(saved.allOpers?.[0].names, { en: 'Amiya', jp: 'アーミヤ', kr: '아미야', tw: '阿米婭' });
  });

  it('does not overwrite the cached operator list when the latest recognition is incomplete', async () => {
    const fixture = await createFixture();
    const previous = {
      timestamp: '2026-10-26T00:00:00.000Z',
      operCount: 1,
      data: [{ id: 'char_1001_amiya', name: '阿米娅', rarity: 5, own: true }]
    };
    await writeFile(join(fixture.dataDir, 'operbox.json'), JSON.stringify(previous), 'utf-8');
    await writeFile(fixture.maaLogPath, operBoxRun([{ id: 'char_1001_amiya', name: '阿米娅' }], false).join('\n'), 'utf-8');

    expectError(await parseOperBoxData(fixture.ports), '解析干员数据失败');

    // 缓存仍按原样读取，只是在读取视图上补出“没有识别目录”的部分识别状态。
    const cached = await getOperBoxData(fixture.ports);
    assert.equal(cached?.timestamp, previous.timestamp);
    assert.equal(cached?.operCount, previous.operCount);
    assert.deepEqual(cached?.data, previous.data);
    assert.deepEqual(cached?.recognition, { status: 'partial', total: 1, owned: 1 });
  });

  it('returns null instead of the previous run when the latest run has no payload yet', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.maaLogPath, [
      ...operBoxRun([{ id: 'char_1001_amiya', name: '阿米娅' }]),
      operBoxTaskLine('TaskChainStart')
    ].join('\n'), 'utf-8');

    assert.equal(await parseOperBoxData(fixture.ports), null);
  });

  it('returns null when the log has no OperBoxInfo payload', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.maaLogPath, 'no operator data here', 'utf-8');

    assert.equal(await parseOperBoxData(fixture.ports), null);
  });

  it('fails the recognition when own_opers is not a list', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.maaLogPath, callbackLine('SubTaskExtraInfo', {
      class: 'asst::OperBoxRecognitionTask',
      details: { done: true, own_opers: { a: 1 } },
      subtask: 'OperBoxRecognitionTask',
      taskchain: 'OperBox',
      taskid: 1,
      uuid: 'fixture',
      what: 'OperBoxInfo'
    }), 'utf-8');

    expectError(await parseOperBoxData(fixture.ports), '解析干员数据失败');
  });
});
