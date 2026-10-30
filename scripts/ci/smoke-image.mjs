// Exercise the real image entrypoint and production HTTP server with no external
// network, user data, schedules or device access. Only MaaCore presence is faked.
//
// Scenarios (all against the image built by the Dockerfile):
// - runtime contents: MAA CLI and Git, Node.js floor, no TypeScript compiler or dev type packages,
//   `node --check` parses the TS entry without a compiler;
// - HTTP: health, readiness, static assets under the configured base path,
//   API authentication and error envelopes, same-origin signaling rejections;
// - HTTPS: the same checks over TLS with a throwaway self-signed certificate, and
//   no plaintext listener on the same port;
// - legacy data volume: a temporary volume pre-seeded with older user data keeps
//   loading after startup and the files survive a graceful stop.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import assert from 'node:assert/strict'

const [image, ...options] = process.argv.slice(2)
if (!image || image.startsWith('-')) {
  throw new Error('Usage: node scripts/ci/smoke-image.mjs IMAGE [--base-path /la-pluma-next/]')
}

/** 只接受已实现的选项，避免 CI 传入拼错的参数后静默按根路径检查。 */
function readOptions(args) {
  const parsed = { basePath: '/' }
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (option !== '--base-path') throw new Error(`Unknown option: ${option}`)
    const value = args[index + 1]
    if (!value || value.startsWith('-')) throw new Error(`${option} requires a value`)
    if (!value.startsWith('/')) throw new Error(`Base path must start with "/": ${value}`)
    parsed.basePath = value.endsWith('/') ? value : `${value}/`
    index += 1
  }
  return parsed
}

const { basePath } = readOptions(options)
const port = 3000
const token = 'ci-smoke-token'
const directory = mkdtempSync(join(tmpdir(), 'la-pluma-smoke-'))
const maaFixture = join(directory, 'maa')
const certificates = join(directory, 'certs')
const legacyData = join(directory, 'legacy-data')
const minimumNode = '24.12.0'

function docker(args, timeout = 120_000) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout })
}

function checked(args, timeout) {
  const result = docker(args, timeout)
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || result.stdout)
  }
  return result.stdout.trim()
}

function compareVersions(actual, minimum) {
  const parse = value => value.split('.').map(part => Number(part))
  const [actualMajor, actualMinor, actualPatch] = parse(actual)
  const [minimumMajor, minimumMinor, minimumPatch] = parse(minimum)
  if ([actualMajor, actualMinor, actualPatch].some(part => Number.isNaN(part))) {
    throw new Error(`Unparsable Node.js version: ${actual}`)
  }
  return actualMajor - minimumMajor || actualMinor - minimumMinor || actualPatch - minimumPatch
}

/**
 * 运行时不安装编译器与开发类型包：类型检查只在构建/CI 阶段执行，镜像里出现
 * `typescript` 或 `@types/*` 说明生产依赖装配回退到了开发依赖。
 */
function assertRuntimeContents() {
  checked(['run', '--rm', '--network=none', '--entrypoint', 'maa', image, '--version'])
  checked(['run', '--rm', '--network=none', '--entrypoint', 'git', image, '--version'])
  const inspect = [
    "const fs = require('node:fs');",
    "const compiler = ['/app/node_modules/typescript', '/app/server/node_modules/typescript', '/app/node_modules/.bin/tsc', '/app/server/node_modules/.bin/tsc'].filter(path => fs.existsSync(path));",
    "const types = ['/app/node_modules/@types', '/app/server/node_modules/@types'].filter(path => fs.existsSync(path));",
    'console.log(JSON.stringify({ node: process.versions.node, compiler, types }));'
  ].join(' ')
  const facts = JSON.parse(checked(['run', '--rm', '--network=none', '--entrypoint', 'node', image, '-e', inspect]))

  if (compareVersions(facts.node, minimumNode) < 0) {
    throw new Error(`Runtime Node.js ${facts.node} is below the supported ${minimumNode} floor`)
  }
  if (facts.compiler.length > 0) {
    throw new Error(`Runtime image ships a TypeScript compiler: ${facts.compiler.join(', ')}`)
  }
  if (facts.types.length > 0) {
    throw new Error(`Runtime image ships development type packages: ${facts.types.join(', ')}`)
  }

  // 原生类型擦除由 Node 自己完成；生产镜像不装编译器也必须能解析入口。
  checked(['run', '--rm', '--network=none', '--entrypoint', 'node', image, '--check', '/app/server/server.ts'])
  console.log(`Runtime image: Node ${facts.node}, no compiler, no dev type packages`)
}

function startContainer(name, { dataDirectory, certificateDirectory } = {}) {
  const args = ['run', '--detach', '--name', name, '--network=none']
  if (dataDirectory) args.push('--mount', `type=bind,source=${dataDirectory},target=/app/server/data`)
  else args.push('--tmpfs', '/app/server/data')
  args.push('--tmpfs', '/root/.config/maa', '--tmpfs', '/root/.local/share/maa')
  args.push('--mount', `type=bind,source=${maaFixture},target=/opt/maa-cli/bin/maa,readonly`)
  args.push('--env', `LA_PLUMA_TOKEN=${token}`)
  if (certificateDirectory) {
    args.push('--mount', `type=bind,source=${certificateDirectory},target=/app/certs,readonly`)
    args.push(
      '--env', 'LA_PLUMA_HTTPS_CERT_PATH=/app/certs/cert.pem',
      '--env', 'LA_PLUMA_HTTPS_KEY_PATH=/app/certs/key.pem'
    )
  }
  args.push(image)
  checked(args)
}

/** 存活与会话分离：先等到 /health，再等到 /readiness 报告可服务。 */
async function waitUntilReady(name, scheme) {
  const origin = `${scheme}://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const health = docker(['exec', name, 'curl', '-fsSk', '--max-time', '5', `${origin}/health`])
    if (health.status === 0 && health.stdout.includes('"status":"ok"')) {
      const readiness = docker(['exec', name, 'curl', '-fsSk', '--max-time', '5', `${origin}/readiness`])
      if (readiness.status === 0 && readiness.stdout.includes('"status":"ready"')) return
    }
    const running = docker(['inspect', '--format', '{{.State.Running}}', name])
    if (running.status !== 0 || running.stdout.trim() !== 'true') {
      throw new Error(`Container stopped before becoming ready: ${running.stderr.trim()}`)
    }
    await setTimeout(500)
  }
  throw new Error('Production container did not become healthy within 60 seconds')
}

/**
 * 在容器内跑 HTTP 断言：镜像只暴露一个端口，测试不依赖宿主机网络或已安装的
 * Node/fetch 版本。`SMOKE_BASE_PATH` 让同一个探针覆盖根路径与子路径构建。
 */
const httpProbe = String.raw`
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';

const origin = process.env.SMOKE_ORIGIN;
const basePath = process.env.SMOKE_BASE_PATH;
const token = process.env.SMOKE_TOKEN;
const scheme = new URL(origin).protocol;
const get = (path, init = {}) => fetch(new URL(path, origin), { signal: AbortSignal.timeout(5000), ...init });
const authorized = { headers: { Authorization: 'Bearer ' + token } };

const health = await get('/health');
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { success: true, status: 'ok' });

const readiness = await get('/readiness');
assert.equal(readiness.status, 200);
assert.equal(readiness.headers.get('cache-control'), 'no-store');
const ready = await readiness.json();
assert.equal(ready.success, true);
assert.equal(ready.status, 'ready');
assert.deepEqual(ready.reasons, []);
assert.equal(ready.checks.lifecycle.state, 'running');
assert.equal(ready.checks.initialization.state, 'completed');
assert.equal(ready.checks.runStore.state, 'ready');

const unauthorized = await get('/api/agent/manifest');
assert.equal(unauthorized.status, 401);
const unauthorizedBody = await unauthorized.json();
assert.equal(unauthorizedBody.success, false);
assert.equal(unauthorizedBody.error.code, 'AGENT_AUTH_REQUIRED');

const manifest = await get('/api/agent/manifest', authorized);
assert.equal(manifest.status, 200);
assert.match(manifest.headers.get('content-type') || '', /json/);
assert.equal((await manifest.json()).success, true);

const missing = await get('/api/agent/smoke-missing-route', authorized);
assert.equal(missing.status, 404);
const missingBody = await missing.json();
assert.equal(missingBody.success, false);
assert.equal(missingBody.error.code, 'AGENT_ROUTE_NOT_FOUND');

// 业务错误沿用同一信封：未知 Run 返回 404 与稳定错误码，而不是框架 HTML。
const missingRun = await get('/api/agent/runs/smoke-missing-run', authorized);
assert.equal(missingRun.status, 404);
const missingRunBody = await missingRun.json();
assert.equal(missingRunBody.success, false);
assert.equal(missingRunBody.error.code, 'AGENT_RUN_NOT_FOUND');
assert.equal(missingRunBody.error.retryable, false);

// 同源信令网关：隐藏管理端点、票据签发鉴权与无票据升级都必须被拒绝。
const signaling = await get('/webrtc-signaling');
assert.equal(signaling.status, 404);
assert.deepEqual(await signaling.json(), { error: 'Not Found' });

const login = await fetch(new URL('/webrtc-signaling/api/login', origin), {
  method: 'POST',
  signal: AbortSignal.timeout(5000)
});
assert.equal(login.status, 401);

const upgradeStatus = await new Promise((resolve, reject) => {
  const client = scheme === 'https:' ? https : http;
  const url = new URL('/webrtc-signaling/connect_client?token=not-a-ticket', origin);
  const request = client.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname + url.search,
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ=='
    },
    rejectUnauthorized: false
  }, response => resolve(response.statusCode));
  request.on('upgrade', () => reject(new Error('gateway accepted an unauthenticated WebSocket upgrade')));
  request.on('error', reject);
  request.end();
});
assert.equal(upgradeStatus, 401);

// 前端产物必须来自本次构建的 base path，深链接回落仍返回应用壳。
const shell = await get(basePath);
assert.equal(shell.status, 200);
const html = await shell.text();
const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1]);
assert(assets.some(path => path.endsWith('.js')), 'Missing production JavaScript');
for (const path of assets) {
  assert(path.startsWith(basePath), 'asset ' + path + ' is outside the configured base path ' + basePath);
  const asset = await get(path);
  assert.equal(asset.status, 200, path);
  assert.match(asset.headers.get('content-type') || '', /javascript|css/, path);
  assert((await asset.text()).length > 0, path);
}
const deepLink = await get(basePath + 'logs');
assert.equal(deepLink.status, 200);
assert.match(await deepLink.text(), /<div id="root">/, 'SPA deep link did not return the application shell');
if (basePath !== '/') {
  const root = await get('/');
  assert.equal(root.status, 404, 'a sub-path image must not serve the application at /');
}
console.log('health, readiness, assets, API errors and signaling passed for ' + basePath);
`

function runProbe(name, scheme, source = httpProbe) {
  const args = [
    'exec',
    '--env', `SMOKE_ORIGIN=${scheme}://127.0.0.1:${port}`,
    '--env', `SMOKE_BASE_PATH=${basePath}`,
    '--env', `SMOKE_TOKEN=${token}`
  ]
  // 自签名证书只用于一次性冒烟容器，不做证书链校验；真实证书的信任链见部署文档。
  if (scheme === 'https') args.push('--env', 'NODE_TLS_REJECT_UNAUTHORIZED=0')
  args.push(name, 'node', '--input-type=module', '-e', source)
  return checked(args)
}

function createCertificate(target) {
  mkdirSync(target, { recursive: true })
  const result = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost',
    '-keyout', join(target, 'key.pem'),
    '-out', join(target, 'cert.pem')
  ], { encoding: 'utf8', timeout: 60_000 })
  if (result.error || result.status !== 0) {
    throw new Error(`HTTPS smoke requires openssl: ${result.error?.message || result.stderr}`)
  }
}

const legacyFiles = {
  'agent-runs.json': { version: 1, savedAt: '2025-01-01T00:00:00.000Z', runs: [] },
  'user-configs/automation-tasks.json': {
    taskFlow: [
      {
        id: 'startup-legacy',
        name: '启动游戏',
        commandId: 'startup',
        params: { clientType: 'Official', accountName: '' },
        enabled: true
      }
    ]
  },
  'user-configs/combat-tasks.json': {
    taskInputs: { copilot: '' },
    advancedParams: { copilot: { loopTimes: '1' } },
    series: 1
  },
  'user-configs/training-queue.json': {
    queue: [
      {
        operatorId: 'char_2027_wang',
        currentElite: 0,
        targetElite: 2,
        priority: 1,
        status: 'pending',
        addedAt: '2025-01-01T00:00:00.000Z'
      }
    ]
  }
}

function createLegacyDataVolume() {
  mkdirSync(join(legacyData, 'user-configs'), { recursive: true })
  for (const [name, content] of Object.entries(legacyFiles)) {
    writeFileSync(join(legacyData, name), `${JSON.stringify(content, null, 2)}\n`)
  }
}

const legacyProbe = String.raw`
import assert from 'node:assert/strict';

const origin = process.env.SMOKE_ORIGIN;
const token = process.env.SMOKE_TOKEN;
const get = path => fetch(new URL(path, origin), {
  headers: { Authorization: 'Bearer ' + token },
  signal: AbortSignal.timeout(5000)
});

const automation = await (await get('/api/agent/config/user/automation-tasks')).json();
assert.equal(automation.success, true);
assert.equal(automation.data.taskFlow[0].id, 'startup-legacy');

const queue = await (await get('/api/agent/config/user/training-queue')).json();
assert.equal(queue.success, true);
assert.equal(queue.data.queue[0].operatorId, 'char_2027_wang');
console.log('legacy user configuration loaded unchanged');
`

/** 容器内以 root 读取数据卷文件；宿主机用户对 0600 的 Run 存储没有读权限。 */
function readDataFile(name, path) {
  return checked(['exec', name, 'cat', `/app/server/data/${path}`])
}

/** 启动不改写既有配置，也不破坏 Run 存储版本。 */
function assertLegacyDataLoadedUnchanged(name) {
  for (const [path, content] of Object.entries(legacyFiles)) {
    const parsed = JSON.parse(readDataFile(name, path))
    if (path === 'agent-runs.json') {
      assert.equal(parsed.version, 1, 'run store version changed')
      assert(Array.isArray(parsed.runs), 'run store lost its runs array')
    } else {
      assert.deepEqual(parsed, content, `${path} was rewritten during startup`)
    }
  }
}

/** 回滚安全：优雅停止后数据卷文件仍在，且 Run 存储停止时落盘为合法 JSON。 */
function assertDataVolumeIntact() {
  for (const path of Object.keys(legacyFiles)) {
    assert(existsSync(join(legacyData, path)), `${path} was removed from the data volume`)
  }
  // Run 存储由容器内 root 以 0600 落盘，宿主机用户读不了；用一次性容器只读挂载读取。
  const stored = JSON.parse(checked([
    'run', '--rm', '--network=none', '--entrypoint', 'cat',
    '--mount', `type=bind,source=${legacyData},target=/data,readonly`,
    image, '/data/agent-runs.json'
  ]))
  assert.equal(stored.version, 1, 'run store version changed after shutdown')
  assert(Array.isArray(stored.runs), 'run store lost its runs array after shutdown')
}

async function withContainer(label, options, run) {
  const name = `la-pluma-smoke-${randomUUID()}`
  const scheme = options.certificateDirectory ? 'https' : 'http'
  try {
    startContainer(name, options)
    await waitUntilReady(name, scheme)
    await run(name, scheme)
    console.log(`Smoke passed: ${label}`)
  } catch (error) {
    const logs = docker(['logs', name])
    console.error(logs.stdout, logs.stderr)
    throw error
  } finally {
    docker(['rm', '--force', name])
  }
}

writeFileSync(
  maaFixture,
  '#!/bin/sh\ncase "$1" in version|--version) echo "MaaCore CI fixture";; *) exit 1;; esac\n',
  { mode: 0o755 }
)

try {
  assertRuntimeContents()

  await withContainer(`startup (${basePath})`, {}, async (name, scheme) => {
    console.log(runProbe(name, scheme))
  })

  createCertificate(certificates)
  await withContainer('HTTPS', { certificateDirectory: certificates }, async (name, scheme) => {
    const plaintext = docker(['exec', name, 'curl', '-fsS', '--max-time', '5', `http://127.0.0.1:${port}/health`])
    assert.notEqual(plaintext.status, 0, 'HTTPS container still answered plaintext HTTP')
    console.log(runProbe(name, scheme))
  })

  createLegacyDataVolume()
  await withContainer('legacy data volume', { dataDirectory: legacyData }, async (name, scheme) => {
    console.log(runProbe(name, scheme, legacyProbe))
    assertLegacyDataLoadedUnchanged(name)
    checked(['stop', '-t', '30', name])
    assertDataVolumeIntact()
    console.log('legacy data volume survived startup and a graceful stop')
  })

  console.log(`Container smoke passed: ${image} (base path ${basePath})`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}
