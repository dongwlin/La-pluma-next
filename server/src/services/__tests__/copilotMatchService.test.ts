import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildOwnedOperatorMap,
  resolveCopilotMatch
} from '../copilotMatchService.ts';
import type { OperBoxFile } from '../dataParserService.ts';

function makeOperBox(data: Record<string, unknown>[]): OperBoxFile {
  return {
    timestamp: '2026-11-12T00:00:00.000Z',
    operCount: data.length,
    data,
    recognition: { status: 'complete', total: data.length, owned: data.length }
  };
}

function jsonContent(value: unknown): string {
  return JSON.stringify(value);
}

describe('buildOwnedOperatorMap', () => {
  it('indexes trimmed names and fills missing progression fields with safe defaults', () => {
    const owned = buildOwnedOperatorMap(makeOperBox([
      { id: 'char_1001_amiya', name: ' 阿米娅 ', rarity: 5, elite: 2, level: 90 },
      { id: 'char_2002_kalts', name: '凯尔希' },
      { id: 'char_3003_unknown', name: '   ' }
    ]));

    assert.deepEqual([...owned.keys()], ['阿米娅', '凯尔希']);
    assert.deepEqual(owned.get('阿米娅'), {
      name: '阿米娅',
      rarity: 5,
      elite: 2,
      level: 90
    });
    assert.deepEqual(owned.get('凯尔希'), {
      name: '凯尔希',
      rarity: 6,
      elite: 0,
      level: 1
    });
  });

  it('returns an empty map for a missing snapshot or entries without names', () => {
    assert.equal(buildOwnedOperatorMap(null).size, 0);
    assert.equal(buildOwnedOperatorMap(makeOperBox([{ id: 'char_1001_amiya' }])).size, 0);
  });
});

describe('resolveCopilotMatch', () => {
  const amiya = buildOwnedOperatorMap(makeOperBox([
    { name: '阿米娅', rarity: 5, elite: 2, level: 90 }
  ]));

  it('marks a fully satisfied single operator as ready', () => {
    const match = resolveCopilotMatch(jsonContent({
      opers: [{ name: '阿米娅', requirements: { elite: 2, level: 90 } }]
    }), amiya);

    assert.deepEqual(match, {
      mode: 'ready',
      missing: [],
      training: [],
      check: [],
      totalSlots: 1
    });
  });

  it('accepts parsed content objects and an empty document', () => {
    assert.deepEqual(resolveCopilotMatch({ opers: [{ name: '阿米娅' }] }, amiya), {
      mode: 'ready',
      missing: [],
      training: [],
      check: [],
      totalSlots: 1
    });
    assert.deepEqual(resolveCopilotMatch('{}', amiya), {
      mode: 'ready',
      missing: [],
      training: [],
      check: [],
      totalSlots: 0
    });
  });

  it('borrows a single missing slot', () => {
    const match = resolveCopilotMatch(jsonContent({
      opers: [{ name: '阿米娅' }, { name: '凯尔希' }]
    }), amiya);

    assert.equal(match?.mode, 'borrow');
    assert.deepEqual(match?.missing, ['凯尔希']);
    assert.equal(match?.totalSlots, 2);
  });

  it('reports a single under-leveled slot as borrow but keeps it in training', () => {
    const match = resolveCopilotMatch(jsonContent({
      opers: [{ name: '阿米娅', requirements: { elite: 2, level: 90 } }]
    }), buildOwnedOperatorMap(makeOperBox([
      { name: '阿米娅', rarity: 5, elite: 1, level: 80 }
    ])));

    assert.equal(match?.mode, 'borrow');
    assert.deepEqual(match?.training, ['阿米娅']);
  });

  it('trains when two owned operators are under-leveled', () => {
    const owned = buildOwnedOperatorMap(makeOperBox([
      { name: '阿米娅', rarity: 5, elite: 0, level: 1 },
      { name: '凯尔希', rarity: 6, elite: 0, level: 1 }
    ]));
    const match = resolveCopilotMatch(jsonContent({
      opers: [
        { name: '阿米娅', requirements: { elite: 2, level: 90 } },
        { name: '凯尔希', requirements: { elite: 2, level: 90 } }
      ]
    }), owned);

    assert.equal(match?.mode, 'train');
    assert.deepEqual(match?.training, ['阿米娅', '凯尔希']);
  });

  it('marks skill and module requirements as pending confirmation instead of ready', () => {
    const match = resolveCopilotMatch(jsonContent({
      opers: [
        { name: '阿米娅', requirements: { elite: 2, level: 90, skill_level: 7 } },
        { name: '凯尔希', requirements: { elite: 2, level: 90, module: 1 } }
      ]
    }), buildOwnedOperatorMap(makeOperBox([
      { name: '阿米娅', rarity: 5, elite: 2, level: 90 },
      { name: '凯尔希', rarity: 6, elite: 2, level: 90 }
    ])));

    assert.equal(match?.mode, 'check');
    assert.deepEqual(match?.check, ['阿米娅', '凯尔希']);
    assert.deepEqual(match?.training, []);
  });

  it('keeps zero-level skill and module requirements verifiable', () => {
    const match = resolveCopilotMatch(jsonContent({
      opers: [{ name: '阿米娅', requirements: { elite: 2, skill_level: 0, module: 0 } }]
    }), amiya);

    assert.equal(match?.mode, 'ready');
    assert.deepEqual(match?.check, []);
  });

  it('ignores potentiality requirements', () => {
    const match = resolveCopilotMatch(jsonContent({
      opers: [{ name: '阿米娅', requirements: { potentiality: 6 } }]
    }), amiya);

    assert.equal(match?.mode, 'ready');
  });

  it('infers elite from the required level when elite is absent', () => {
    const content = jsonContent({
      opers: [{ name: '阿米娅', requirements: { level: 80 } }]
    });
    const eliteOneLevelEighty = buildOwnedOperatorMap(makeOperBox([
      { name: '阿米娅', rarity: 6, elite: 1, level: 80 }
    ]));
    const eliteOneLevelSeventyNine = buildOwnedOperatorMap(makeOperBox([
      { name: '阿米娅', rarity: 6, elite: 1, level: 79 }
    ]));
    const eliteZeroLevelNinety = buildOwnedOperatorMap(makeOperBox([
      { name: '阿米娅', rarity: 6, elite: 0, level: 90 }
    ]));

    assert.equal(resolveCopilotMatch(content, eliteOneLevelEighty)?.mode, 'ready');
    assert.deepEqual(resolveCopilotMatch(content, eliteOneLevelSeventyNine)?.training, ['阿米娅']);
    assert.deepEqual(resolveCopilotMatch(content, eliteZeroLevelNinety)?.training, ['阿米娅']);
  });

  it('counts lower elite level caps in the progress score', () => {
    const match = resolveCopilotMatch(jsonContent({
      opers: [{ name: '阿米娅', requirements: { level: 80 } }]
    }), buildOwnedOperatorMap(makeOperBox([
      { name: '阿米娅', rarity: 6, elite: 2, level: 1 }
    ])));

    assert.equal(match?.mode, 'ready');
    assert.deepEqual(match?.training, []);
  });

  it('blocks on two missing slots or more than thirteen slots', () => {
    const twoMissing = resolveCopilotMatch(jsonContent({
      opers: [{ name: '阿米娅' }, { name: '凯尔希' }, { name: '瑕光' }]
    }), amiya);
    assert.equal(twoMissing?.mode, 'blocked');
    assert.deepEqual(twoMissing?.missing, ['凯尔希', '瑕光']);

    const fourteenSlots = resolveCopilotMatch(jsonContent({
      opers: Array.from({ length: 14 }, () => ({ name: '阿米娅' }))
    }), amiya);
    assert.equal(fourteenSlots?.mode, 'blocked');
    assert.equal(fourteenSlots?.totalSlots, 14);
  });

  it('borrows a fully owned thirteen-slot setup', () => {
    const match = resolveCopilotMatch(jsonContent({
      opers: Array.from({ length: 13 }, () => ({ name: '阿米娅' }))
    }), amiya);

    assert.equal(match?.mode, 'borrow');
    assert.equal(match?.totalSlots, 13);
  });

  it('takes the best owned candidate in a group', () => {
    const owned = buildOwnedOperatorMap(makeOperBox([
      { name: '塞雷娅', rarity: 6, elite: 2, level: 90 },
      { name: '星熊', rarity: 6, elite: 0, level: 1 }
    ]));
    const ready = resolveCopilotMatch(jsonContent({
      groups: [{
        name: '重装',
        opers: [
          { name: '星熊', requirements: { elite: 2, level: 90 } },
          { name: '塞雷娅' }
        ]
      }]
    }), owned);

    assert.equal(ready?.mode, 'ready');
    assert.deepEqual(ready?.missing, []);
    assert.equal(ready?.totalSlots, 1);
  });

  it('reports an under-leveled group in training', () => {
    const owned = buildOwnedOperatorMap(makeOperBox([
      { name: '塞雷娅', rarity: 6, elite: 0, level: 1 },
      { name: '星熊', rarity: 6, elite: 0, level: 1 }
    ]));
    const match = resolveCopilotMatch(jsonContent({
      groups: [{
        name: '重装',
        opers: [
          { name: '塞雷娅', requirements: { elite: 2, level: 90 } },
          { name: '星熊', requirements: { elite: 2, level: 90 } }
        ]
      }]
    }), owned);

    assert.equal(match?.mode, 'borrow');
    assert.deepEqual(match?.training, ['重装']);
  });

  it('marks a group with unverifiable requirements as pending confirmation', () => {
    const match = resolveCopilotMatch(jsonContent({
      groups: [{
        name: '医疗',
        opers: [{ name: '阿米娅', requirements: { skill_level: 8 } }]
      }]
    }), amiya);

    assert.equal(match?.mode, 'check');
    assert.deepEqual(match?.check, ['医疗']);
  });

  it('falls back to candidate names for an unnamed group and reports it missing', () => {
    const match = resolveCopilotMatch(jsonContent({
      groups: [{
        opers: [{ name: '塞雷娅' }, { name: '星熊' }]
      }]
    }), amiya);

    assert.equal(match?.mode, 'borrow');
    assert.deepEqual(match?.missing, ['塞雷娅 / 星熊']);
  });

  it('returns null for invalid content or an empty owned snapshot', () => {
    assert.equal(resolveCopilotMatch('not-json', amiya), null);
    assert.equal(resolveCopilotMatch('[1,2]', amiya), null);
    assert.equal(resolveCopilotMatch('null', amiya), null);
    assert.equal(resolveCopilotMatch(null, amiya), null);
    assert.equal(resolveCopilotMatch(jsonContent({ opers: [] }), new Map()), null);
  });
});
