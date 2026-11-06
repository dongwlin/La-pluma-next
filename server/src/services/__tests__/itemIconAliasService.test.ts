import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  loadItemIconAliasTable,
  parseItemIconAliasTable,
  parseItemIndexAliasTable,
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

describe('parseItemIndexAliasTable', () => {
  it('maps item_index icon file names to both item ids and icon ids', () => {
    const table = parseItemIndexAliasTable({
      '4001': { name: '赤金', icon: 'GOLD.png' },
      '30011': { name: '固源岩', icon: '30011.png' }
    });

    assert.deepEqual(table.byIconId.get('GOLD'), ['4001']);
    assert.deepEqual(table.byLowercaseIconId.get('gold'), ['4001']);
    assert.equal(table.byItemId.get('4001'), 'GOLD');
    assert.equal(table.byItemId.get('30011'), '30011');
  });

  it('ignores entries without a usable icon file name', () => {
    const table = parseItemIndexAliasTable({
      '4001': { name: '赤金', icon: 'GOLD.png' },
      '4002': { name: '无图标' },
      '4003': { name: '坏文件名', icon: 'bad icon.png' },
      'bad id': { name: '坏键', icon: 'BAD.png' },
      '4004': 'not-an-entry'
    });

    assert.deepEqual(table.byIconId.get('GOLD'), ['4001']);
    assert.equal(table.byIconId.size, 1);
    assert.equal(table.byItemId.size, 1);
    assert.equal(parseItemIndexAliasTable(null).byIconId.size, 0);
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

  it('falls back to item_index icon fields when the item table is missing', async () => {
    resetItemIconAliasCacheForTests();
    const itemIndexPath = join(fixtureDir, 'item_index.json');
    await writeFile(itemIndexPath, JSON.stringify({
      '4001': { name: '赤金', icon: 'GOLD.png' },
      '30011': { name: '固源岩', icon: '30011.png' }
    }), 'utf-8');

    const table = await loadItemIconAliasTable(join(fixtureDir, 'missing-item_table.json'), itemIndexPath);

    assert.deepEqual(table.byIconId.get('GOLD'), ['4001']);
    assert.equal(table.byItemId.get('30011'), '30011');
  });

  it('falls back to item_index when the item table cannot be parsed', async () => {
    resetItemIconAliasCacheForTests();
    const itemTablePath = join(fixtureDir, 'broken-item_table.json');
    const itemIndexPath = join(fixtureDir, 'broken-item_index.json');
    await writeFile(itemTablePath, '{not json', 'utf-8');
    await writeFile(itemIndexPath, JSON.stringify({ '4001': { icon: 'GOLD.png' } }), 'utf-8');

    const table = await loadItemIconAliasTable(itemTablePath, itemIndexPath);

    assert.deepEqual(table.byIconId.get('GOLD'), ['4001']);
  });

  it('prefers item_table entries when both sources are available', async () => {
    resetItemIconAliasCacheForTests();
    const itemTablePath = join(fixtureDir, 'preferred-item_table.json');
    const itemIndexPath = join(fixtureDir, 'preferred-item_index.json');
    await writeFile(itemTablePath, JSON.stringify({ items: { '4001': { iconId: 'GOLD_TABLE' } } }), 'utf-8');
    await writeFile(itemIndexPath, JSON.stringify({ '4001': { icon: 'GOLD_INDEX.png' } }), 'utf-8');

    const table = await loadItemIconAliasTable(itemTablePath, itemIndexPath);

    assert.deepEqual(table.byIconId.get('GOLD_TABLE'), ['4001']);
    assert.equal(table.byIconId.get('GOLD_INDEX'), undefined);
  });

  it('follows item_index changes while the item table stays missing', async () => {
    resetItemIconAliasCacheForTests();
    const itemTablePath = join(fixtureDir, 'missing-item_table.json');
    const itemIndexPath = join(fixtureDir, 'changing-item_index.json');
    await writeFile(itemIndexPath, JSON.stringify({ '4001': { icon: 'GOLD.png' } }), 'utf-8');

    const first = await loadItemIconAliasTable(itemTablePath, itemIndexPath);
    assert.deepEqual(first.byIconId.get('GOLD'), ['4001']);

    await writeFile(itemIndexPath, JSON.stringify({ '4002': { icon: 'DIAMOND_ICON.png' } }), 'utf-8');
    const second = await loadItemIconAliasTable(itemTablePath, itemIndexPath);

    assert.equal(second.byIconId.get('GOLD'), undefined);
    assert.deepEqual(second.byIconId.get('DIAMOND_ICON'), ['4002']);
  });

  it('returns an empty table when the item table and item_index are both missing', async () => {
    resetItemIconAliasCacheForTests();
    const table = await loadItemIconAliasTable(
      join(fixtureDir, 'missing-item_table.json'),
      join(fixtureDir, 'missing-item_index.json')
    );

    assert.equal(table.byIconId.size, 0);
    assert.equal(table.byItemId.size, 0);
  });
});
