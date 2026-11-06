import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { createLaPlumaApp } from '../../app.ts';
import type { RuntimeEnvSource } from '../../config/runtimeConfig.ts';
import type { WebrtcSignalingGateway } from '../../services/webrtcSignalingGateway.ts';
import { WEBRTC_SIGNALING_PATH } from '../../services/webrtcSignalingGateway.ts';

const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-game-assets-'));
const assetRoot = join(fixtureDir, 'game-assets');
const itemDir = join(assetRoot, 'item');
const avatarDir = join(assetRoot, 'avatar');
const outsideDir = join(fixtureDir, 'outside');
// 真实 MAA 资源目录位于 `~/.local/share/maa`，点目录下的文件也必须能发送。
const maaDataDir = join(fixtureDir, '.local', 'maa');
const maaTemplateDir = join(maaDataDir, 'resource', 'template');
const aliasMaaDir = join(fixtureDir, 'alias-maa');
const aliasItemTablePath = join(aliasMaaDir, 'resource', 'gamedata', 'excel', 'item_table.json');
const fallbackMaaDir = join(fixtureDir, 'fallback-maa');
const fallbackItemIndexPath = join(fallbackMaaDir, 'resource', 'item_index.json');
const upstreamRoot = join(fixtureDir, 'upstream-assets');
const upstreamItemDir = join(upstreamRoot, 'item');

const ITEM_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]);
const AVATAR_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x03, 0x04]);
const MAA_ITEM_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x05, 0x06]);
const MAA_AVATAR_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x07, 0x08]);
const GOLD_ITEM_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x09, 0x0a]);
const UPSTREAM_GOLD_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0b, 0x0c]);
const OUTSIDE_BYTES = Buffer.from('outside-secret');

await mkdir(itemDir, { recursive: true });
await mkdir(avatarDir, { recursive: true });
await mkdir(outsideDir, { recursive: true });
await mkdir(join(maaTemplateDir, 'items'), { recursive: true });
await mkdir(join(maaTemplateDir, 'avatar'), { recursive: true });
await writeFile(join(itemDir, '30011.png'), ITEM_BYTES);
await writeFile(join(avatarDir, 'char_002_amiya.png'), AVATAR_BYTES);
await writeFile(join(maaTemplateDir, 'items', '2001.png'), MAA_ITEM_BYTES);
await writeFile(join(maaTemplateDir, 'avatar', 'char_4004_pudd.png'), MAA_AVATAR_BYTES);
await mkdir(join(aliasMaaDir, 'resource', 'gamedata', 'excel'), { recursive: true });
await writeFile(aliasItemTablePath, JSON.stringify({
  items: {
    '4001': { iconId: 'GOLD' },
    '30011': { iconId: 'MTL_SL_G1' }
  }
}));
await mkdir(join(fallbackMaaDir, 'resource'), { recursive: true });
await writeFile(fallbackItemIndexPath, JSON.stringify({
  '4001': { name: '赤金', icon: 'GOLD.png' },
  '30011': { name: '固源岩', icon: '30011.png' }
}), 'utf-8');
await mkdir(upstreamItemDir, { recursive: true });
await mkdir(join(upstreamRoot, 'avatar'), { recursive: true });
await writeFile(join(itemDir, '4001.png'), GOLD_ITEM_BYTES);
await writeFile(join(upstreamItemDir, 'GOLD.png'), UPSTREAM_GOLD_BYTES);
await writeFile(join(itemDir, 'notes.txt'), 'not an image');
await writeFile(join(itemDir, '.hidden.png'), ITEM_BYTES);
await writeFile(join(outsideDir, 'secret.png'), OUTSIDE_BYTES);
await symlink(join(outsideDir, 'secret.png'), join(itemDir, 'escape.png'));
await mkdir(join(itemDir, 'directory.png'));

const servers: Server[] = [];

function stubSignalingGateway(): WebrtcSignalingGateway {
  return {
    proxyPath: WEBRTC_SIGNALING_PATH,
    async handleLogin(_req, res) {
      res.json({ token: 'stub' });
    },
    async handleUpgrade() {},
    attach() {},
    close() {}
  };
}

async function listen(env: RuntimeEnvSource = {
  LA_PLUMA_GAME_ASSET_DIR: assetRoot,
  // 别名映射默认不读开发机的 MAA 资源，未显式注入时只按文件名直连。
  MAA_DATA_DIR: join(fixtureDir, 'empty-maa')
}): Promise<string> {
  const server = createServer(createLaPlumaApp({
    env,
    signalingGateway: stubSignalingGateway()
  }));
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    assert.ok(server);
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('GET /game-assets local icon and avatar routes', () => {
  it('serves item icons and avatars from the configured local root', async () => {
    const baseUrl = await listen();

    const item = await fetch(`${baseUrl}/game-assets/item/30011.png?v=7`);
    assert.equal(item.status, 200);
    assert.equal(item.headers.get('content-type'), 'image/png');
    assert.equal(item.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.deepEqual(Buffer.from(await item.arrayBuffer()), ITEM_BYTES);

    const avatar = await fetch(`${baseUrl}/game-assets/avatar/char_002_amiya.png`);
    assert.equal(avatar.status, 200);
    assert.equal(avatar.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await avatar.arrayBuffer()), AVATAR_BYTES);
  });

  it('serves the MAA resource templates when no asset directory is configured', async () => {
    const baseUrl = await listen({ MAA_DATA_DIR: maaDataDir });

    const item = await fetch(`${baseUrl}/game-assets/item/2001.png`);
    assert.equal(item.status, 200);
    assert.equal(item.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await item.arrayBuffer()), MAA_ITEM_BYTES);

    const avatar = await fetch(`${baseUrl}/game-assets/avatar/char_4004_pudd.png`);
    assert.equal(avatar.status, 200);
    assert.equal(avatar.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await avatar.arrayBuffer()), MAA_AVATAR_BYTES);
  });

  it('serves item ids directly and resolves icon id keys through the local item table', async () => {
    const baseUrl = await listen({ LA_PLUMA_GAME_ASSET_DIR: assetRoot, MAA_DATA_DIR: aliasMaaDir });

    const direct = await fetch(`${baseUrl}/game-assets/item/30011.png`);
    assert.equal(direct.status, 200);
    assert.deepEqual(Buffer.from(await direct.arrayBuffer()), ITEM_BYTES);

    const resolved = await fetch(`${baseUrl}/game-assets/item/GOLD.png?v=9`);
    assert.equal(resolved.status, 200);
    assert.equal(resolved.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await resolved.arrayBuffer()), GOLD_ITEM_BYTES);

    const lowercase = await fetch(`${baseUrl}/game-assets/item/mtl_sl_g1.png`);
    assert.equal(lowercase.status, 200);
    assert.deepEqual(Buffer.from(await lowercase.arrayBuffer()), ITEM_BYTES);
  });

  it('resolves icon id keys through item_index when the item table is missing', async () => {
    const baseUrl = await listen({ LA_PLUMA_GAME_ASSET_DIR: assetRoot, MAA_DATA_DIR: fallbackMaaDir });

    const resolved = await fetch(`${baseUrl}/game-assets/item/GOLD.png`);

    assert.equal(resolved.status, 200);
    assert.equal(resolved.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await resolved.arrayBuffer()), GOLD_ITEM_BYTES);
  });

  it('resolves item ids through item_index when the item table is missing', async () => {
    const baseUrl = await listen({ LA_PLUMA_GAME_ASSET_DIR: upstreamRoot, MAA_DATA_DIR: fallbackMaaDir });

    const byItemId = await fetch(`${baseUrl}/game-assets/item/4001.png`);
    assert.equal(byItemId.status, 200);
    assert.deepEqual(Buffer.from(await byItemId.arrayBuffer()), UPSTREAM_GOLD_BYTES);
  });

  it('returns 404 when an item icon key cannot be resolved', async () => {
    const withItemTable = await listen({ LA_PLUMA_GAME_ASSET_DIR: assetRoot, MAA_DATA_DIR: aliasMaaDir });
    const unknown = await fetch(`${withItemTable}/game-assets/item/UNKNOWN_ICON.png`);
    assert.equal(unknown.status, 404);
    assert.doesNotMatch(unknown.headers.get('content-type') ?? '', /text\/html/);

    const withoutItemTable = await listen();
    const unresolved = await fetch(`${withoutItemTable}/game-assets/item/GOLD.png`);
    assert.equal(unresolved.status, 404);
  });

  it('resolves item ids to icon id file names for upstream-style asset directories', async () => {
    const baseUrl = await listen({ LA_PLUMA_GAME_ASSET_DIR: upstreamRoot, MAA_DATA_DIR: aliasMaaDir });

    const byItemId = await fetch(`${baseUrl}/game-assets/item/4001.png`);
    assert.equal(byItemId.status, 200);
    assert.deepEqual(Buffer.from(await byItemId.arrayBuffer()), UPSTREAM_GOLD_BYTES);

    const byIconId = await fetch(`${baseUrl}/game-assets/item/GOLD.png`);
    assert.equal(byIconId.status, 200);
    assert.deepEqual(Buffer.from(await byIconId.arrayBuffer()), UPSTREAM_GOLD_BYTES);
  });

  it('returns an empty 404 for unmatched asset paths instead of an HTML shell', async () => {
    const baseUrl = await listen();

    for (const path of ['/game-assets/item/30011.png/extra', '/game-assets/unknown']) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 404, path);
      assert.doesNotMatch(response.headers.get('content-type') ?? '', /text\/html/, path);
      assert.equal(await response.text(), '', path);
    }
  });

  it('serves a replaced file at the new versioned URL', async () => {
    const baseUrl = await listen();
    await writeFile(join(itemDir, '30011.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x05]));

    const response = await fetch(`${baseUrl}/game-assets/item/30011.png?v=8`);

    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x05]));
    await writeFile(join(itemDir, '30011.png'), ITEM_BYTES);
  });

  it('rejects unknown kinds, missing files, and directories', async () => {
    const baseUrl = await listen();

    for (const path of [
      '/game-assets/other/30011.png',
      '/game-assets/item/missing.png',
      '/game-assets/item/directory.png',
      '/game-assets/item/notes.txt',
      '/game-assets/item/.hidden.png'
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 404, path);
    }
  });

  it('rejects encoded path traversal, separators, and symlink escapes', async () => {
    const baseUrl = await listen();

    for (const fileName of [
      encodeURIComponent('../outside/secret.png'),
      encodeURIComponent('..\\outside\\secret.png'),
      '..%2Foutside%2Fsecret.png',
      '%2e%2e%2foutside%2fsecret.png',
      encodeURIComponent('/etc/passwd'),
      encodeURIComponent('escape.png'),
      encodeURIComponent('sub/../../outside/secret.png'),
      encodeURIComponent('30011.png\u0000.txt')
    ]) {
      const response = await fetch(`${baseUrl}/game-assets/item/${fileName}`);
      assert.equal(response.status, 404, fileName);
    }
  });

  it('rejects non-image extensions even when the file exists', async () => {
    const baseUrl = await listen();
    await writeFile(join(itemDir, 'script.svg'), '<svg />');
    await writeFile(join(itemDir, 'payload.html'), '<html />');

    for (const fileName of ['script.svg', 'payload.html', 'notes.txt']) {
      const response = await fetch(`${baseUrl}/game-assets/item/${fileName}`);
      assert.equal(response.status, 404, fileName);
    }
  });

  it('returns 404 when the configured asset root does not exist', async () => {
    const baseUrl = await listen({ LA_PLUMA_GAME_ASSET_DIR: join(fixtureDir, 'missing-root') });

    const response = await fetch(`${baseUrl}/game-assets/item/30011.png`);

    assert.equal(response.status, 404);
  });

  it('serves local assets for same-origin pages only and keeps them out of CORS', async () => {
    const baseUrl = await listen();
    const crossOrigin = 'http://console.example:5173';

    const sameOrigin = await fetch(`${baseUrl}/game-assets/item/30011.png`);
    assert.equal(sameOrigin.status, 200);
    assert.equal(sameOrigin.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(sameOrigin.headers.get('access-control-allow-origin'), null);

    const crossOriginRead = await fetch(`${baseUrl}/game-assets/item/30011.png`, {
      headers: { Origin: crossOrigin }
    });
    assert.equal(crossOriginRead.status, 200);
    assert.equal(crossOriginRead.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(crossOriginRead.headers.get('access-control-allow-origin'), null);

    const missing = await fetch(`${baseUrl}/game-assets/item/missing.png`, {
      headers: { Origin: crossOrigin }
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(missing.headers.get('access-control-allow-origin'), null);

    const preflight = await fetch(`${baseUrl}/game-assets/item/30011.png`, {
      method: 'OPTIONS',
      headers: { Origin: crossOrigin, 'Access-Control-Request-Method': 'GET' }
    });
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);

    // CORS 只保留给 /api：跨域 API 调用与预检行为不变。
    const manifest = await fetch(`${baseUrl}/api/agent/manifest`, { headers: { Origin: crossOrigin } });
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get('access-control-allow-origin'), '*');
  });
});
