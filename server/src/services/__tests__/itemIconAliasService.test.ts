import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  loadItemIconAliasTable,
  parseItemIconAliasTable,
  resetItemIconAliasCacheForTests
} from '../itemIconAliasService.ts';

const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-item-icon-alias-'));

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('parseItemIconAliasTable', () => {
  it('maps icon ids and item ids in both directions', () => {
    const table = parseItemIconAliasTable({
      items: {
        '4001': { iconId: 'GOLD' },
        '30011': { iconId: 'MTL_SL_G1' }
      }
    });

    assert.deepEqual(table.byIconId.get('GOLD'), ['4001']);
    assert.deepEqual(table.byLowercaseIconId.get('mtl_sl_g1'), ['30011']);
    assert.equal(table.byItemId.get('4001'), 'GOLD');
    assert.equal(table.byItemId.get('30011'), 'MTL_SL_G1');
  });

  it('keeps every item id that shares an icon id as an ordered candidate', () => {
    const table = parseItemIconAliasTable({
      items: {
        '2026recruitment10_1': { iconId: '2026recruitment10_1' },
        '2026recruitment10_register_1': { iconId: '2026recruitment10_1' }
      }
    });

    assert.deepEqual(table.byIconId.get('2026recruitment10_1'), [
      '2026recruitment10_1',
      '2026recruitment10_register_1'
    ]);
  });

  it('ignores malformed payloads and entries instead of failing', () => {
    const table = parseItemIconAliasTable({
      items: {
        '4001': { iconId: 'GOLD' },
        '4002': 'not-an-entry',
        'bad id': { iconId: 'DIAMOND' },
        '4003': { iconId: 'bad icon id' },
        '4004': {}
      }
    });

    assert.deepEqual(table.byIconId.get('GOLD'), ['4001']);
    assert.equal(table.byIconId.size, 1);
    assert.equal(table.byItemId.size, 1);
    assert.equal(parseItemIconAliasTable(null).byIconId.size, 0);
    assert.equal(parseItemIconAliasTable({}).byItemId.size, 0);
  });
});

describe('loadItemIconAliasTable', () => {
  it('reads the local item table and follows file changes', async () => {
    resetItemIconAliasCacheForTests();
    const itemTablePath = join(fixtureDir, 'item_table.json');
    await writeFile(itemTablePath, JSON.stringify({ items: { '4001': { iconId: 'GOLD' } } }), 'utf-8');

    const first = await loadItemIconAliasTable(itemTablePath);

    assert.deepEqual(first.byIconId.get('GOLD'), ['4001']);

    await writeFile(itemTablePath, JSON.stringify({ items: { '4002': { iconId: 'DIAMOND' } } }), 'utf-8');
    const second = await loadItemIconAliasTable(itemTablePath);

    assert.equal(second.byIconId.get('GOLD'), undefined);
    assert.deepEqual(second.byIconId.get('DIAMOND'), ['4002']);
  });

  it('returns an empty table when the item table is missing or invalid', async () => {
    resetItemIconAliasCacheForTests();
    const missing = await loadItemIconAliasTable(join(fixtureDir, 'missing-item_table.json'));
    assert.equal(missing.byIconId.size, 0);
    assert.equal(missing.byItemId.size, 0);

    const invalidPath = join(fixtureDir, 'invalid-item_table.json');
    await writeFile(invalidPath, '{not json', 'utf-8');
    const invalid = await loadItemIconAliasTable(invalidPath);
    assert.equal(invalid.byIconId.size, 0);
    assert.equal(invalid.byItemId.size, 0);
  });
});
