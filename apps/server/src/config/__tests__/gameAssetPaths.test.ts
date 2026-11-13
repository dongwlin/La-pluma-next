import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { resolveGameAssetPaths } from '../gameAssetPaths.ts';

describe('resolveGameAssetPaths', () => {
  it('uses the MAA resource templates when no asset directory is configured', () => {
    const paths = resolveGameAssetPaths({ env: { MAA_RESOURCE_DIR: '/maa/resource' } });

    assert.equal(paths.rootDir, join('/maa/resource', 'template'));
    assert.equal(paths.itemDir, join('/maa/resource', 'template', 'items'));
    assert.equal(paths.avatarDir, join('/maa/resource', 'template', 'avatar'));
  });

  it('derives the template directory from the MAA data directory', () => {
    const paths = resolveGameAssetPaths({ env: { MAA_DATA_DIR: '/maa/data' } });

    assert.equal(paths.itemDir, join('/maa/data', 'resource', 'template', 'items'));
    assert.equal(paths.avatarDir, join('/maa/data', 'resource', 'template', 'avatar'));
  });

  it('keeps the upstream repository layout for an explicit asset directory', () => {
    const paths = resolveGameAssetPaths({ env: { LA_PLUMA_GAME_ASSET_DIR: '/game-assets' } });

    assert.equal(paths.rootDir, '/game-assets');
    assert.equal(paths.itemDir, join('/game-assets', 'item'));
    assert.equal(paths.avatarDir, join('/game-assets', 'avatar'));
  });

  it('treats a blank asset directory override as unset', () => {
    const paths = resolveGameAssetPaths({
      env: { LA_PLUMA_GAME_ASSET_DIR: '   ', MAA_RESOURCE_DIR: '/maa/resource' }
    });

    assert.equal(paths.itemDir, join('/maa/resource', 'template', 'items'));
  });
});
