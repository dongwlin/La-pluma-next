import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import type { DiagnosticsReport } from '../services/diagnosticsService.ts';
import {
  agentApiBaseUrl,
  closeHttpServers,
  readError,
  readSuccess,
  silenceLoggers,
  startHttpServer,
  stubSignalingGateway
} from './support/httpTestHelpers.ts';

// 真实 HTTP 回归：/diagnostics 会启动 MAA 版本、ADB 与资源目录等多项外部探测。
// 这里用记录调用的假 CLI / 假 ADB 验证并发合并、短 TTL 缓存、no-store 与匿名限流，
// 不依赖开发机安装的 maa、adb 或真实资源目录。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-diagnostics-http-'));
const maaLogDir = join(fixtureDir, 'maa-logs');
const maaCacheDir = join(fixtureDir, 'maa-cache');
const xdgDataHome = join(fixtureDir, 'xdg-data');
const xdgStateHome = join(fixtureDir, 'xdg-state');
const xdgConfigHome = join(fixtureDir, 'xdg-config');
const resourceDir = join(xdgDataHome, 'maa', 'resource');
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');
const fakeAdbPath = join(fixtureDir, 'fake-adb.js');
const brokenAdbPath = join(fixtureDir, 'fake-adb-broken.js');
const cliCallLog = join(fixtureDir, 'maa-calls.log');
const adbCallLog = join(fixtureDir, 'adb-calls.log');
const deviceAddress = '127.0.0.1:7555';

await mkdir(maaLogDir, { recursive: true });
await mkdir(maaCacheDir, { recursive: true });
await mkdir(join(resourceDir, 'tasks'), { recursive: true });
await mkdir(join(resourceDir, 'template'), { recursive: true });
await mkdir(join(xdgConfigHome, 'maa'), { recursive: true });
await writeFile(
  join(resourceDir, 'version.json'),
  JSON.stringify({ last_updated: new Date().toISOString() })
);

await writeFile(fakeCliPath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_MAA_CALL_LOG, args.join(' ') + '\\n');
if (args[0] === 'version') {
  process.stdout.write('maa-cli v0.7.0\\nMaaCore v6.2.3\\n');
  process.exit(0);
}
if (args[0] === 'dir') {
  const dirs = {
    resource: ${JSON.stringify(resourceDir)},
    log: ${JSON.stringify(maaLogDir)},
    cache: ${JSON.stringify(maaCacheDir)},
    config: ${JSON.stringify(join(xdgConfigHome, 'maa'))}
  };
  process.stdout.write(dirs[args[1]] || '');
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });

await writeFile(fakeAdbPath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_ADB_CALL_LOG, args.join(' ') + '\\n');
if (args[0] === 'version') {
  process.stdout.write('Android Debug Bridge version 1.0.41\\n');
} else if (args[0] === 'devices') {
  process.stdout.write('List of devices attached\\n${deviceAddress}\\tdevice product:arknights model:MuMu device:x86\\n');
} else if (args[0] === 'connect') {
  process.stdout.write('connected\\n');
} else if (args[0] === '-s') {
  const shellIndex = args.indexOf('shell');
  const command = shellIndex >= 0 ? args.slice(shellIndex + 1).join(' ') : '';
  if (command.startsWith('dumpsys window')) {
    process.stdout.write('mCurrentFocus=Window{1a2b3c com.hypergryph.arknights/.MainActivity}\\n');
  }
}
`, { mode: 0o755 });

await writeFile(brokenAdbPath, `#!${process.execPath}
process.stderr.write('adb: cannot start daemon\\n');
process.exit(1);
`, { mode: 0o755 });

process.env.MAA_CLI_PATH = fakeCliPath;
process.env.ADB_PATH = fakeAdbPath;
process.env.ADB_ADDRESS = deviceAddress;
process.env.MAA_CACHE_DIR = maaCacheDir;
process.env.XDG_DATA_HOME = xdgDataHome;
process.env.XDG_STATE_HOME = xdgStateHome;
process.env.XDG_CONFIG_HOME = xdgConfigHome;
process.env.FAKE_MAA_CALL_LOG = cliCallLog;
process.env.FAKE_ADB_CALL_LOG = adbCallLog;
process.env.LA_PLUMA_AGENT_RUN_STORE = join(fixtureDir, 'agent-runs.json');
process.env.LA_PLUMA_MAA_LOCK_FILE = join(fixtureDir, 'maa-execution.lock');
process.env.LA_PLUMA_DROP_RECORDS_DIR = join(fixtureDir, 'drop-records');
process.env.LA_PLUMA_WEBRTC_DIR = join(fixtureDir, 'webrtc');
process.env.LA_PLUMA_WEBRTC_ICE_SERVERS = '';

const { createLaPlumaApp } = await import('../app.ts');
const { resetAgentDiagnosticsProbeCachesForTests } = await import('../controllers/agentDiagnosticsController.ts');
const { WEBRTC_SIGNALING_PATH } = await import('../services/webrtcSignalingGateway.ts');

silenceLoggers(['Api', 'MaaService', 'AgentRoutes', 'AgentRunService']);

const servers: Server[] = [];

async function readCalls(logPath: string): Promise<string[]> {
  try {
    return (await readFile(logPath, 'utf-8')).trim().split('\n').filter(Boolean);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function clearCallLogs(): Promise<void> {
  await writeFile(cliCallLog, '');
  await writeFile(adbCallLog, '');
}

interface ProbeCalls {
  cli: string[];
  adb: string[];
}

async function probeCalls(): Promise<ProbeCalls> {
  // 并发假子进程各自追加日志，行序不稳定；这里只比较调用集合。
  const [cli, adb] = await Promise.all([readCalls(cliCallLog), readCalls(adbCallLog)]);
  return { cli: cli.sort(), adb: adb.sort() };
}

async function fetchDiagnostics(port: number, query = '?command=startup'): Promise<Response> {
  return fetch(`${agentApiBaseUrl(port)}/diagnostics${query}`);
}

afterEach(async () => {
  await closeHttpServers(servers);
});

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

before(() => {
  resetAgentDiagnosticsProbeCachesForTests();
});

describe('GET /api/agent/diagnostics probe amplification', () => {
  it('coalesces concurrent probes and serves the cached report as no-store', async () => {
    resetAgentDiagnosticsProbeCachesForTests();
    const port = await startHttpServer(
      createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway(WEBRTC_SIGNALING_PATH) }),
      servers
    );

    // 预热：连接配置等模块级缓存只在首次读取时解析，不计入本次探测调用次数。
    assert.equal((await fetchDiagnostics(port)).status, 200);

    resetAgentDiagnosticsProbeCachesForTests();
    await clearCallLogs();
    const single = await fetchDiagnostics(port);
    assert.equal(single.status, 200);
    const singleReport = await readSuccess<DiagnosticsReport>(single);
    assert.equal(singleReport.data.ok, true);
    const singleCalls = await probeCalls();
    assert.deepEqual(singleCalls.cli.filter(line => line === 'version'), ['version']);
    assert.ok(singleCalls.cli.some(line => line === 'dir resource'));
    assert.ok(singleCalls.adb.length > 0);

    // TTL 内的第二个请求复用同一批探测，不新增任何子进程。
    await clearCallLogs();
    const cached = await fetchDiagnostics(port);
    assert.equal(cached.status, 200);
    assert.equal(cached.headers.get('cache-control'), 'no-store');
    const cachedReport = await readSuccess<DiagnosticsReport>(cached);
    assert.deepEqual(cachedReport.data.checks, singleReport.data.checks);
    assert.deepEqual(await probeCalls(), { cli: [], adb: [] });

    // 并发请求共享同一次在途探测：调用次数与单个请求完全一致。
    resetAgentDiagnosticsProbeCachesForTests();
    await clearCallLogs();
    const concurrent = await Promise.all([
      fetchDiagnostics(port),
      fetchDiagnostics(port),
      fetchDiagnostics(port)
    ]);
    for (const response of concurrent) assert.equal(response.status, 200);
    assert.deepEqual(await probeCalls(), singleCalls);

    resetAgentDiagnosticsProbeCachesForTests();
  });

  it('rejects anonymous requests beyond the per-source diagnostics budget', async () => {
    resetAgentDiagnosticsProbeCachesForTests();
    const port = await startHttpServer(createLaPlumaApp({
      env: {},
      signalingGateway: stubSignalingGateway(WEBRTC_SIGNALING_PATH),
      loginRateLimit: { maxAnonymousDiagnostics: 2 }
    }), servers);

    assert.equal((await fetchDiagnostics(port)).status, 200);
    assert.equal((await fetchDiagnostics(port)).status, 200);

    await clearCallLogs();
    const blocked = await fetchDiagnostics(port);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('cache-control'), 'no-store');
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    const blockedBody = await readError(blocked);
    assert.equal(blockedBody.error.code, 'AGENT_RATE_LIMITED');
    assert.equal(blockedBody.error.retryable, true);
    assert.ok(Number(blockedBody.error.details.retryAfterSeconds) >= 1);
    // 限流在处理器之前拒绝：不再触发新的外部探测。
    assert.deepEqual(await probeCalls(), { cli: [], adb: [] });

    resetAgentDiagnosticsProbeCachesForTests();
  });

  it('keeps the diagnostics budget out of token-protected deployments', async () => {
    resetAgentDiagnosticsProbeCachesForTests();
    const port = await startHttpServer(createLaPlumaApp({
      env: { LA_PLUMA_TOKEN: 'api-secret' },
      signalingGateway: stubSignalingGateway(WEBRTC_SIGNALING_PATH),
      loginRateLimit: { maxAnonymousDiagnostics: 1 }
    }), servers);
    const authorized = { headers: { Authorization: 'Bearer api-secret' } };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${agentApiBaseUrl(port)}/diagnostics`, authorized);
      assert.equal(response.status, 200);
    }
    const anonymous = await fetch(`${agentApiBaseUrl(port)}/diagnostics`);
    assert.equal(anonymous.status, 401);

    resetAgentDiagnosticsProbeCachesForTests();
  });
});

describe('GET /api/agent/diagnostics HTTP contract', () => {
  it('returns the four documented checks in a healthy environment', async () => {
    resetAgentDiagnosticsProbeCachesForTests();
    const port = await startHttpServer(
      createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway(WEBRTC_SIGNALING_PATH) }),
      servers
    );

    const response = await fetchDiagnostics(port);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    const body = await readSuccess<DiagnosticsReport>(response);
    assert.equal(body.success, true);
    const data = body.data;
    assert.equal(data.ok, true);
    assert.equal(data.status, 'ok');
    assert.equal(data.conclusion, '运行环境正常，可以执行任务');
    assert.match(data.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(data.checks.map(check => check.id), ['runtime', 'connection', 'resource', 'execution']);
    for (const check of data.checks) {
      assert.equal(check.status, 'pass', `${check.id} must pass`);
      assert.equal(typeof check.title, 'string');
      assert.ok(Array.isArray(check.details));
    }

    resetAgentDiagnosticsProbeCachesForTests();
  });

  it('rejects an invalid profile id with a JSON validation error', async () => {
    resetAgentDiagnosticsProbeCachesForTests();
    const port = await startHttpServer(
      createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway(WEBRTC_SIGNALING_PATH) }),
      servers
    );

    const response = await fetch(`${agentApiBaseUrl(port)}/diagnostics?profileId=bad%20id!`);
    assert.equal(response.status, 400);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    const body = await readError(response);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'AGENT_VALIDATION_PROFILE_ID_INVALID');
    assert.equal(body.error.retryable, false);
    assert.deepEqual(body.error.details, { profileId: 'bad id!' });

    resetAgentDiagnosticsProbeCachesForTests();
  });
});

describe('GET /api/agent/diagnostics connection probe failure', () => {
  it('reports an ADB launch failure as the connection probe error', async () => {
    resetAgentDiagnosticsProbeCachesForTests();
    const port = await startHttpServer(
      createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway(WEBRTC_SIGNALING_PATH) }),
      servers
    );
    const query = new URLSearchParams({ adbPath: brokenAdbPath, address: deviceAddress });

    const response = await fetch(`${agentApiBaseUrl(port)}/diagnostics?${query}`);

    assert.equal(response.status, 200);
    const body = await readSuccess<DiagnosticsReport>(response);
    const connection = body.data.checks.find(check => check.id === 'connection');
    assert.ok(connection);
    assert.equal(connection.status, 'fail');
    assert.match(connection.summary, /ADB 连接探测失败/);
    assert.ok(connection.details.some(detail => detail.startsWith('error: ')));
    assert.ok(connection.details.some(detail => detail.includes('cannot start daemon')));
    resetAgentDiagnosticsProbeCachesForTests();
  });
});

describe('GET /api/agent/diagnostics execution preflight', () => {
  it('accepts an unknown command and reports it in the execution check', async () => {
    resetAgentDiagnosticsProbeCachesForTests();
    const port = await startHttpServer(
      createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway(WEBRTC_SIGNALING_PATH) }),
      servers
    );

    const response = await fetch(`${agentApiBaseUrl(port)}/diagnostics?command=not-a-command`);

    assert.equal(response.status, 200);
    const body = await readSuccess<DiagnosticsReport>(response);
    const execution = body.data.checks.find(check => check.id === 'execution');
    assert.ok(execution);
    assert.equal(execution.status, 'fail');
    assert.match(execution.summary, /任务参数预检失败/);
    assert.ok(execution.details.some(detail => detail.startsWith('allowed: ')));
    resetAgentDiagnosticsProbeCachesForTests();
  });
});
