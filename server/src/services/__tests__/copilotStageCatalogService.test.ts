import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createCopilotStageCatalog,
  matchCopilotStage,
  parseCopilotStageCatalog
} from '../copilotStageCatalogService.ts';

const LEVELS = [
  { stage_id: 'main_01-07', cat_one: '主题曲', cat_two: '第一章 黑暗时代·下', cat_three: '1-7', name: '暴君' },
  { stage_id: 'main_01-07#f#', cat_one: '主题曲', cat_two: '第一章 黑暗时代·下', cat_three: '1-7', name: '暴君' },
  { stage_id: 'wk_melee_6', cat_one: '资源收集', cat_two: '货物运送', cat_three: 'CE-6', name: '实验原件押运' },
  { stage_id: 'main_11-05', cat_one: '主题曲', cat_two: '第十一章 淬火尘霾', cat_three: '11-6（标准）', name: '演绎文明' },
  { stage_id: 'lt_02_01', cat_one: '保全派驻', cat_two: '塔山农业实验平台', cat_three: 'LT-2', name: '未授权区域' },
  { stage_id: 'lt_02_02', cat_one: '保全派驻', cat_two: '塔山农业实验平台', cat_three: 'LT-2', name: '临时通道' },
  { cat_one: '主题曲', cat_three: '9-9', name: '缺少 stage_id' },
  'not-a-record'
];

const catalog = parseCopilotStageCatalog({ status_code: 200, data: LEVELS });

describe('parseCopilotStageCatalog', () => {
  it('keeps valid entries and collapses difficulty suffixes', () => {
    assert.deepEqual(catalog.map(entry => entry.stageId), [
      'main_01-07',
      'wk_melee_6',
      'main_11-05',
      'lt_02_01',
      'lt_02_02'
    ]);
    assert.deepEqual(catalog[0], {
      stageId: 'main_01-07',
      code: '1-7',
      name: '暴君',
      category: '主题曲',
      zone: '第一章 黑暗时代·下'
    });
  });

  it('returns an empty list for a payload without entries', () => {
    assert.deepEqual(parseCopilotStageCatalog(null), []);
    assert.deepEqual(parseCopilotStageCatalog({ status_code: 500, data: null }), []);
    assert.deepEqual(parseCopilotStageCatalog([{ stage_id: '' }]), []);
  });
});

describe('matchCopilotStage', () => {
  it('matches an internal stage id regardless of case', () => {
    const match = matchCopilotStage(catalog, 'MAIN_01-07');

    assert.equal(match.status, 'matched');
    assert.equal(match.status === 'matched' ? match.stage.stageId : '', 'main_01-07');
  });

  it('matches a display code regardless of case', () => {
    const match = matchCopilotStage(catalog, 'ce-6');

    assert.equal(match.status, 'matched');
    assert.equal(match.status === 'matched' ? match.stage.stageId : '', 'wk_melee_6');
  });

  it('ignores a difficulty suffix in the catalog code', () => {
    const match = matchCopilotStage(catalog, '11-6');

    assert.equal(match.status, 'matched');
    assert.equal(match.status === 'matched' ? match.stage.stageId : '', 'main_11-05');
  });

  it('matches a stage name', () => {
    const match = matchCopilotStage(catalog, '暴君');

    assert.equal(match.status, 'matched');
    assert.equal(match.status === 'matched' ? match.stage.stageId : '', 'main_01-07');
  });

  it('reports every candidate when one code covers several stages', () => {
    const match = matchCopilotStage(catalog, 'LT-2');

    assert.equal(match.status, 'ambiguous');
    assert.deepEqual(
      match.status === 'ambiguous' ? match.candidates.map(entry => entry.name) : [],
      ['未授权区域', '临时通道']
    );
  });

  it('reports a missing stage instead of echoing the input', () => {
    assert.deepEqual(matchCopilotStage(catalog, 'ZZ-99'), { status: 'missing' });
    assert.deepEqual(matchCopilotStage(catalog, '   '), { status: 'missing' });
  });
});

describe('createCopilotStageCatalog', () => {
  it('reuses the catalog within the ttl and reloads after it', async () => {
    let now = 0;
    let requests = 0;
    const instance = createCopilotStageCatalog({
      requestJson: async () => {
        requests += 1;
        return { data: { status_code: 200, data: LEVELS } };
      },
      now: () => now
    });

    const first = await instance.resolve('1-7');
    assert.equal(first.status, 'matched');

    now = 29 * 60_000;
    await instance.resolve('CE-6');
    assert.equal(requests, 1);

    now = 31 * 60_000;
    await instance.resolve('CE-6');
    assert.equal(requests, 2);
  });

  it('coalesces concurrent loads into one request', async () => {
    let requests = 0;
    let release = (): void => {};
    const gate = new Promise<void>(resolve => {
      release = () => resolve();
    });
    const instance = createCopilotStageCatalog({
      requestJson: async () => {
        requests += 1;
        await gate;
        return { data: { data: LEVELS } };
      }
    });

    const first = instance.resolve('1-7');
    const second = instance.resolve('CE-6');
    release();
    const [left, right] = await Promise.all([first, second]);

    assert.equal(requests, 1);
    assert.equal(left.status, 'matched');
    assert.equal(right.status, 'matched');
  });

  it('serves the cached catalog when a refresh fails', async () => {
    let now = 0;
    let fail = false;
    let requests = 0;
    const instance = createCopilotStageCatalog({
      requestJson: async () => {
        requests += 1;
        if (fail) throw new Error('offline');
        return { data: { data: LEVELS } };
      },
      now: () => now
    });

    assert.equal((await instance.resolve('1-7')).status, 'matched');

    now = 31 * 60_000;
    fail = true;
    const match = await instance.resolve('CE-6');

    assert.equal(match.status, 'matched');
    assert.equal(requests, 2);
  });

  it('backs off after a failed refresh instead of retrying every search', async () => {
    let now = 0;
    let requests = 0;
    const instance = createCopilotStageCatalog({
      requestJson: async () => {
        requests += 1;
        if (requests === 2) throw new Error('offline');
        return { data: { data: LEVELS } };
      },
      now: () => now
    });

    await instance.resolve('1-7');
    now = 31 * 60_000;
    await instance.resolve('CE-6');
    now += 30_000;
    await instance.resolve('CE-6');

    assert.equal(requests, 2);
  });

  it('rejects when the catalog is empty or malformed', async () => {
    const instance = createCopilotStageCatalog({
      requestJson: async () => ({ data: { status_code: 200, data: [] } })
    });

    await assert.rejects(instance.resolve('1-7'), /关卡目录/);
  });

  it('resolves an internal stage id without loading the catalog', async () => {
    let requests = 0;
    const instance = createCopilotStageCatalog({
      requestJson: async () => {
        requests += 1;
        return { data: { data: LEVELS } };
      }
    });

    const match = await instance.resolve('MAIN_01-07#f#');

    assert.equal(match.status, 'matched');
    assert.equal(match.status === 'matched' ? match.stage.stageId : '', 'main_01-07');
    assert.equal(requests, 0);
  });
});
