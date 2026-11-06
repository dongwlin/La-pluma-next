import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildOperatorRecognitionSummary,
  describeOperBoxRecognition,
  mergeOperatorCatalog,
  parseOperBoxCatalog,
  parseOperBoxRecognitionPayload,
  resolveRecognitionCoverage
} from '../operatorCatalogModel.ts';

const amiya = {
  id: 'char_1001_amiya',
  name: '阿米娅',
  name_en: 'Amiya',
  name_jp: 'アーミヤ',
  name_kr: '아미야',
  name_tw: '阿米婭',
  rarity: 5,
  own: true
};

const kaltsit = {
  id: 'char_2002_kalts',
  name: '凯尔希',
  name_en: "Kal'tsit",
  rarity: 6,
  own: false
};

const ownedEntry = {
  id: 'char_1001_amiya',
  name: '阿米娅',
  rarity: 5,
  elite: 2,
  level: 90,
  potential: 6,
  own: true
};

describe('operbox recognition payload', () => {
  it('keeps the all_opers catalog with ownership markers and localized names', () => {
    const payload = parseOperBoxRecognitionPayload({
      done: true,
      own_opers: [ownedEntry],
      all_opers: [amiya, kaltsit]
    });

    assert.ok(payload);
    assert.equal(payload.complete, true);
    assert.deepEqual(payload.owned, [ownedEntry]);
    assert.deepEqual(payload.catalog, [
      {
        id: 'char_1001_amiya',
        name: '阿米娅',
        names: { en: 'Amiya', jp: 'アーミヤ', kr: '아미야', tw: '阿米婭' },
        rarity: 5,
        owned: true
      },
      {
        id: 'char_2002_kalts',
        name: '凯尔希',
        names: { en: "Kal'tsit" },
        rarity: 6,
        owned: false
      }
    ]);
  });

  it('reads old payloads without all_opers as an owned-only snapshot', () => {
    const payload = parseOperBoxRecognitionPayload({ done: true, own_opers: [ownedEntry] });

    assert.ok(payload);
    assert.deepEqual(payload.owned, [ownedEntry]);
    assert.deepEqual(payload.catalog, []);
  });

  it('marks a payload whose own_opers is not a list as unparsable', () => {
    assert.equal(parseOperBoxRecognitionPayload({ done: true, own_opers: { a: 1 } }), null);
    assert.equal(parseOperBoxRecognitionPayload({ done: true }), null);
    assert.equal(parseOperBoxRecognitionPayload(null), null);
  });

  it('accepts an empty payload and an empty catalog without inventing operators', () => {
    const payload = parseOperBoxRecognitionPayload({ done: true, own_opers: [], all_opers: [] });

    assert.ok(payload);
    assert.equal(payload.complete, true);
    assert.deepEqual(payload.owned, []);
    assert.deepEqual(payload.catalog, []);
  });

  it('keeps localized names optional and skips catalog entries without an id or name', () => {
    const catalog = parseOperBoxCatalog([
      { id: 'char_a', name: '甲', own: false },
      { id: 'char_b', name: '乙', name_en: 'B', own: true },
      { name: '缺少 id' },
      { id: 'char_c' },
      'not-an-operator'
    ]);

    assert.deepEqual(catalog, [
      { id: 'char_a', name: '甲', owned: false },
      { id: 'char_b', name: '乙', names: { en: 'B' }, owned: true }
    ]);
    assert.equal(parseOperBoxCatalog({ id: 'char_a' }), null);
  });
});

describe('operator catalog merge', () => {
  it('keeps the local catalog fields and adds recognized operators missing locally', () => {
    const merged = mergeOperatorCatalog(
      [{ id: 'char_1001_amiya', name: '阿米娅', rarity: 5, profession: 'CASTER', position: 'RANGED' }],
      [{ id: 'char_1001_amiya', name: 'Amiya', rarity: 5, names: { en: 'Amiya' } }, { id: 'char_2002_kalts', name: '凯尔希', rarity: 6 }]
    );

    assert.deepEqual(merged, [
      {
        id: 'char_1001_amiya',
        name: '阿米娅',
        names: { en: 'Amiya' },
        rarity: 5,
        profession: 'CASTER',
        position: 'RANGED'
      },
      { id: 'char_2002_kalts', name: '凯尔希', rarity: 6 }
    ]);
  });
});

describe('operator recognition coverage', () => {
  const catalogIds = ['char_a', 'char_b', 'char_c'];

  it('confirms owned and unowned entries from a complete recognition catalog', () => {
    const coverage = resolveRecognitionCoverage(catalogIds, {
      status: 'complete',
      catalog: [
        { id: 'char_a', name: '甲' },
        { id: 'char_b', name: '乙' },
        { id: 'char_c', name: '丙' }
      ],
      ownedIds: new Set(['char_a'])
    });

    assert.equal(coverage.status, 'complete');
    assert.deepEqual([...coverage.unownedIds], ['char_b', 'char_c']);
    assert.deepEqual(coverage.missing, []);
  });

  it('keeps operators outside the claimed catalog unrecognized', () => {
    const coverage = resolveRecognitionCoverage(catalogIds, {
      status: 'complete',
      catalog: [
        { id: 'char_a', name: '甲' },
        { id: 'char_b', name: '乙' }
      ],
      ownedIds: new Set(['char_a'])
    });

    assert.equal(coverage.status, 'partial');
    assert.deepEqual([...coverage.unownedIds], ['char_b']);
    assert.deepEqual(coverage.missing, ['char_c']);
  });

  it('only confirms owned operators when the snapshot has no recognition catalog', () => {
    const coverage = resolveRecognitionCoverage(catalogIds, {
      status: 'partial',
      catalog: [],
      ownedIds: new Set(['char_a'])
    });

    assert.equal(coverage.status, 'partial');
    assert.deepEqual([...coverage.unownedIds], []);
    assert.deepEqual(coverage.missing, ['char_b', 'char_c']);
  });

  it('reports every catalog operator as unrecognized without a snapshot', () => {
    const coverage = resolveRecognitionCoverage(catalogIds, null);

    assert.equal(coverage.status, 'missing');
    assert.deepEqual(coverage.missing, catalogIds);
    assert.equal(coverage.knownIds.size, 0);
    assert.equal(coverage.unownedIds.size, 0);
  });

  it('builds the recognition summary from coverage and counts', () => {
    const coverage = resolveRecognitionCoverage(catalogIds, null);
    const summary = buildOperatorRecognitionSummary(coverage, {
      recognizedAt: null,
      total: 3,
      owned: 0
    });

    assert.deepEqual(summary, {
      status: 'missing',
      recognizedAt: null,
      total: 3,
      owned: 0,
      unknown: 3,
      missing: catalogIds
    });
  });
});

describe('operbox snapshot recognition info', () => {
  it('reports a complete snapshot when the recognition catalog is present', () => {
    assert.deepEqual(
      describeOperBoxRecognition({ allOpers: [amiya, kaltsit], operTotal: 2, operCount: 1 }),
      { status: 'complete', total: 2, owned: 1 }
    );
  });

  it('reports a partial snapshot for caches written without a catalog', () => {
    assert.deepEqual(
      describeOperBoxRecognition({ allOpers: null, operTotal: null, operCount: 3 }),
      { status: 'partial', total: 3, owned: 3 }
    );
  });
});
