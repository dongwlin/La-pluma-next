// Exercise the real image entrypoint and production HTTP server with no external
// network, user data, schedules or device access. Only MaaCore presence is faked.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'

const image = process.argv[2]
if (!image || image.startsWith('-')) throw new Error('Usage: node scripts/ci/smoke-image.mjs IMAGE')
const directory = mkdtempSync(join(tmpdir(), 'la-pluma-smoke-'))
const name = `la-pluma-smoke-${randomUUID()}`
const fixture = join(directory, 'maa')
const docker = args => spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 })
const checked = args => {
  const result = docker(args)
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout)
  return result.stdout.trim()
}

try {
  // Check the native CLI binary before replacing it for the server startup test.
  checked(['run', '--rm', '--network=none', '--entrypoint', 'maa', image, '--version'])
  writeFileSync(fixture, '#!/bin/sh\ncase "$1" in version|--version) echo "MaaCore CI fixture";; *) exit 1;; esac\n', { mode: 0o755 })
  checked([
    'run', '--detach', '--name', name, '--network=none',
    '--tmpfs', '/app/server/data', '--tmpfs', '/root/.config/maa', '--tmpfs', '/root/.local/share/maa',
    '--mount', `type=bind,source=${fixture},target=/opt/maa-cli/bin/maa,readonly`,
    '--env', 'LA_PLUMA_TOKEN=ci-smoke-token', image,
  ])

  const deadline = Date.now() + 60_000
  let ready = false
  while (Date.now() < deadline) {
    const result = docker(['exec', name, 'node', '--input-type=module', '-e', `
      const response = await fetch('http://127.0.0.1:3000/health', { signal: AbortSignal.timeout(1000) });
      if (!response.ok || (await response.json()).status !== 'ok') process.exit(1);
    `])
    if (result.status === 0) { ready = true; break }
    if (checked(['inspect', '--format', '{{.State.Running}}', name]) !== 'true') break
    await setTimeout(500)
  }
  if (!ready) throw new Error('Production container did not become healthy within 60 seconds')

  checked(['exec', name, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const origin = 'http://127.0.0.1:3000';
    const get = path => fetch(new URL(path, origin), { signal: AbortSignal.timeout(5000) });
    const response = await get('/');
    assert.equal(response.status, 200);
    const html = await response.text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]+\\.(?:js|css))"/g)].map(match => match[1]);
    assert(assets.some(path => path.endsWith('.js')), 'Missing production JavaScript');
    for (const path of assets) {
      const asset = await get(path);
      assert.equal(asset.status, 200, path);
      assert.match(asset.headers.get('content-type') || '', /javascript|css/, path);
      assert((await asset.text()).length > 0, path);
    }
    assert.equal((await get('/api/agent/manifest')).status, 401);
    const api = await fetch(origin + '/api/agent/manifest', {
      headers: { Authorization: 'Bearer ci-smoke-token' }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(api.status, 200);
    assert.match(api.headers.get('content-type') || '', /json/);
    console.log('Production entrypoint, health, assets and API authentication passed');
  `])
  console.log(`Container smoke passed: ${image}`)
} catch (error) {
  const logs = docker(['logs', name])
  console.error(logs.stdout, logs.stderr)
  throw error
} finally {
  docker(['rm', '--force', name])
  rmSync(directory, { recursive: true, force: true })
}
