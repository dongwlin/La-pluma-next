import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-diagnostics-'));
const maaLogDir = join(fixtureDir, 'maa-logs');
const maaCacheDir = join(fixtureDir, 'maa-cache');
const xdgDataHome = join(fixtureDir, 'xdg-data');
const xdgStateHome = join(fixtureDir, 'xdg-state');
const xdgConfigHome = join(fixtureDir, 'xdg-config');
const resourceDir = join(xdgDataHome, 'maa', 'resource');
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');
const fakeAdbPath = join(fixtureDir, 'fake-adb.js');
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
const args = process.argv.slice(2);
if (args[0] === 'dir') {
  const dirs = {
    cache: ${JSON.stringify(maaCacheDir)},
    log: ${JSON.stringify(maaLogDir)},
    config: ${JSON.stringify(join(xdgConfigHome, 'maa'))},
    resource: ${JSON.stringify(resourceDir)}
  };
  process.stdout.write(dirs[args[1]] || '');
  process.exit(0);
}
if (args[0] === 'version') {
  process.stdout.write('maa-cli v0.7.0\\nMaaCore v6.2.3\\n');
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });

await writeFile(fakeAdbPath, `#!${process.execPath}
const args = process.argv.slice(2);
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

const previousEnv = new Map<string, string | undefined>();
function setEnv(name: string, value: string): void {
  previousEnv.set(name, process.env[name]);
  process.env[name] = value;
}

setEnv('MAA_CLI_PATH', fakeCliPath);
setEnv('ADB_PATH', fakeAdbPath);
setEnv('MAA_CACHE_DIR', maaCacheDir);
setEnv('XDG_DATA_HOME', xdgDataHome);
setEnv('XDG_STATE_HOME', xdgStateHome);
setEnv('XDG_CONFIG_HOME', xdgConfigHome);
setEnv('LA_PLUMA_AGENT_RUN_STORE', join(fixtureDir, 'agent-runs.json'));
setEnv('LA_PLUMA_MAA_LOCK_FILE', join(fixtureDir, 'maa-execution.lock'));
setEnv('LA_PLUMA_DROP_RECORDS_DIR', join(fixtureDir, 'drop-records'));
setEnv('LA_PLUMA_COPILOT_PROGRESS_STORE', join(fixtureDir, 'copilot-progress.json'));
setEnv('LA_PLUMA_WEBRTC_DIR', join(fixtureDir, 'webrtc'));
setEnv('LA_PLUMA_WEBRTC_ICE_SERVERS', '');

const { default: agentRouter } = await import('../agent.ts');
const { loggerManager } = await import('../../utils/logger.ts');

for (const loggerName of ['Api', 'MaaService', 'AgentRoutes', 'AgentRunService', 'Scheduler']) {
  loggerManager.getLogger(loggerName).enableConsole = false;
}

interface MountedRoute {
  path: string;
  methods?: Record<string, boolean>;
  stack: Array<{ handle: RouteHandler }>;
}

type RouteHandler = (req: unknown, res: DiagnosticsResponse, next: (error?: unknown) => void) => unknown;

interface DiagnosticsResponse {
  statusCode: number;
  body: Record<string, unknown>;
  jsonCalls: number;
  status(code: number): DiagnosticsResponse;
  json(body: Record<string, unknown>): DiagnosticsResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function isMountedRoute(value: unknown): value is MountedRoute {
  if (!isRecord(value)) return false;
  if (typeof value.path !== 'string') return false;
  if (value.methods !== undefined && !isRecord(value.methods)) return false;
  if (!Array.isArray(value.stack)) return false;
  return value.stack.every(entry => isRecord(entry) && typeof entry.handle === 'function');
}

function findRoute(router: unknown, method: string, path: string): MountedRoute | null {
  if (!isRecord(router) || !Array.isArray(router.stack)) return null;
  for (const layer of router.stack) {
    if (!isRecord(layer)) continue;
    if (isMountedRoute(layer.route)) {
      if (layer.route.path === path && layer.route.methods?.[method]) return layer.route;
      continue;
    }
    const nested = findRoute(layer.handle, method, path);
    if (nested) return nested;
  }
  return null;
}

function diagnosticsHandler(): RouteHandler {
  const route = findRoute(agentRouter, 'get', '/diagnostics');
  assert.ok(route, 'missing GET /diagnostics route');
  const handler = route.stack.at(-1)?.handle;
  assert.ok(handler, 'missing GET /diagnostics handler');
  return handler;
}

function response(): DiagnosticsResponse {
  return {
    statusCode: 200,
    body: {},
    jsonCalls: 0,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.jsonCalls += 1;
      return this;
    }
  };
}

interface DiagnosticsCheckView {
  id: string;
  title: string;
  status: string;
  summary: string;
  details: string[];
  hint?: string;
  locations?: string[];
}

type DiagnosticsDataView = {
  ok: boolean;
  status: string;
  generatedAt: string;
  conclusion: string;
  checks: DiagnosticsCheckView[];
};

function diagnosticsData(body: Record<string, unknown>): DiagnosticsDataView {
  assert.equal(body.success, true, 'diagnostics response must use the success envelope');
  const data = body.data;
  assert.ok(isRecord(data), 'diagnostics data must be an object');
  assert.equal(typeof data.ok, 'boolean');
  assert.equal(typeof data.status, 'string');
  assert.equal(typeof data.generatedAt, 'string');
  assert.equal(typeof data.conclusion, 'string');
  assert.ok(Array.isArray(data.checks));
  return data as DiagnosticsDataView;
}

function checkById(data: DiagnosticsDataView, id: string): DiagnosticsCheckView {
  const found = data.checks.find(check => check.id === id);
  assert.ok(found, `missing diagnostics check ${id}`);
  return found;
}

describe('GET /api/agent/diagnostics', () => {
  before(() => {
    assert.ok(diagnosticsHandler());
  });

  after(async () => {
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it('returns the four documented checks in a healthy environment', async () => {
    const res = response();
    await diagnosticsHandler()({
      headers: {},
      query: { adbPath: fakeAdbPath, address: deviceAddress, command: 'startup' }
    }, res, () => {});

    assert.equal(res.statusCode, 200);
    const data = diagnosticsData(res.body);
    assert.equal(data.ok, true);
    assert.equal(data.status, 'ok');
    assert.match(data.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(data.conclusion, '运行环境正常，可以执行任务');
    assert.deepEqual(data.checks.map(check => check.id), ['runtime', 'connection', 'resource', 'execution']);
    for (const check of data.checks) {
      assert.equal(check.status, 'pass', `${check.id} must pass`);
      assert.equal(typeof check.title, 'string');
      assert.ok(Array.isArray(check.details));
    }
    assert.deepEqual(checkById(data, 'connection').locations, [fakeAdbPath, deviceAddress]);
    assert.deepEqual(checkById(data, 'resource').locations, [resourceDir, join(resourceDir, 'version.json')]);
    assert.ok(checkById(data, 'execution').details.includes('command: startup'));
  });

  it('reports an invalid command as a failed execution check instead of an HTTP error', async () => {
    const res = response();
    await diagnosticsHandler()({
      headers: {},
      query: { adbPath: fakeAdbPath, address: deviceAddress, command: 'not-a-command' }
    }, res, () => {});

    assert.equal(res.statusCode, 200);
    const data = diagnosticsData(res.body);
    assert.equal(data.ok, false);
    assert.equal(data.status, 'error');
    const execution = checkById(data, 'execution');
    assert.equal(execution.status, 'fail');
    assert.match(data.conclusion, /^发现 1 项异常：任务预检/);
    assert.ok(execution.details.some(detail => detail.startsWith('allowed: startup')));
  });

  it('translates a failed ADB probe into a readable check with locations', async () => {
    const missingAdbPath = join(fixtureDir, 'missing-adb');
    const res = response();
    await diagnosticsHandler()({
      headers: {},
      query: { adbPath: missingAdbPath, address: deviceAddress }
    }, res, () => {});

    assert.equal(res.statusCode, 200);
    const data = diagnosticsData(res.body);
    assert.equal(data.ok, false);
    assert.equal(data.status, 'error');
    const connection = checkById(data, 'connection');
    assert.equal(connection.status, 'fail');
    assert.match(connection.summary, /^ADB 未连接/);
    assert.deepEqual(connection.locations, [missingAdbPath, deviceAddress]);
    assert.ok(connection.details.some(detail => detail.startsWith('message: ADB 不可用')));
  });

  it('rejects an invalid profile id through the shared validation error path', async () => {
    const res = response();
    let forwarded: unknown;
    await diagnosticsHandler()({
      headers: {},
      query: { profileId: 'bad id!' }
    }, res, error => {
      forwarded = error;
    });

    assert.equal(res.jsonCalls, 0);
    assert.ok(isRecord(forwarded));
    assert.equal(forwarded.statusCode, 400);
    assert.equal(forwarded.code, 'AGENT_VALIDATION_PROFILE_ID_INVALID');
  });
});
