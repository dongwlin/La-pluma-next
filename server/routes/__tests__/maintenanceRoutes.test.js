import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';

// 剩余维护入口已从 agent.js 拆到独立 router：这里先按实际挂载关系核对
// 完整路由清单与顺序，再通过 createLaPlumaApp 验证真实 HTTP 的鉴权、
// 连接覆盖、dryRun 与平台信息契约。所有外部依赖都用假 CLI / 假 ADB
// 或临时目录，不触碰真实设备与资源更新。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-maintenance-routes-'));
const maaLogDir = join(fixtureDir, 'maa-logs');
const xdgDataHome = join(fixtureDir, 'xdg-data');
const xdgStateHome = join(fixtureDir, 'xdg-state');
const xdgConfigHome = join(fixtureDir, 'xdg-config');
const maaConfigDir = join(xdgConfigHome, 'maa');
const resourceDir = join(xdgDataHome, 'maa', 'resource');
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');
const fakeAdbPath = join(fixtureDir, 'fake-adb.js');
const cliCallLog = join(fixtureDir, 'maa-calls.log');
const adbCallLog = join(fixtureDir, 'adb-calls.log');
const adbConnectedMarker = join(fixtureDir, 'adb-connected');

await mkdir(maaLogDir, { recursive: true });
await mkdir(maaConfigDir, { recursive: true });
await mkdir(resourceDir, { recursive: true });
await writeFile(join(resourceDir, 'version.json'), JSON.stringify({
  last_updated: new Date().toISOString().slice(0, 10)
}), 'utf-8');

await writeFile(fakeCliPath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_MAA_LOG, args.join(' ') + '\\n');
if (args[0] === 'version') {
  process.stdout.write('maa-cli v0.7.0\\nMaaCore v6.2.3\\n');
} else if (args[0] === 'dir' && args[1] === 'log') {
  process.stdout.write(process.env.FAKE_MAA_LOG_DIR || '');
} else if (args[0] === 'dir' && args[1] === 'config') {
  process.stdout.write(process.env.FAKE_MAA_CONFIG_DIR || '');
} else if (args[0] === 'dir' && args[1] === 'resource') {
  process.stdout.write(process.env.FAKE_MAA_RESOURCE_DIR || '');
} else {
  process.exit(1);
}
`, { mode: 0o755 });

await writeFile(fakeAdbPath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_ADB_LOG, args.join(' ') + '\\n');
if (args[0] === 'version') {
  process.stdout.write('Android Debug Bridge version 1.0.41\\n');
} else if (args[0] === 'devices') {
  const connected = fs.existsSync(process.env.FAKE_ADB_CONNECTED);
  process.stdout.write('List of devices attached\\n' + (connected ? process.env.FAKE_ADB_ADDRESS + '\\tdevice\\n' : ''));
} else if (args[0] === 'connect') {
  fs.writeFileSync(process.env.FAKE_ADB_CONNECTED, '1');
  process.stdout.write('connected\\n');
} else {
  process.exit(0);
}
`, { mode: 0o755 });

process.env.MAA_CLI_PATH = fakeCliPath;
process.env.ADB_PATH = fakeAdbPath;
process.env.FAKE_MAA_LOG = cliCallLog;
process.env.FAKE_MAA_LOG_DIR = maaLogDir;
process.env.FAKE_MAA_CONFIG_DIR = maaConfigDir;
process.env.FAKE_MAA_RESOURCE_DIR = resourceDir;
process.env.FAKE_ADB_LOG = adbCallLog;
process.env.FAKE_ADB_CONNECTED = adbConnectedMarker;
process.env.FAKE_ADB_ADDRESS = '127.0.0.1:5555';
process.env.XDG_DATA_HOME = xdgDataHome;
process.env.XDG_STATE_HOME = xdgStateHome;
process.env.XDG_CONFIG_HOME = xdgConfigHome;
process.env.LA_PLUMA_AGENT_RUN_STORE = join(fixtureDir, 'agent-runs.json');
process.env.LA_PLUMA_MAA_LOCK_FILE = join(fixtureDir, 'maa-execution.lock');
process.env.LA_PLUMA_WEBRTC_DIR = join(fixtureDir, 'webrtc');
process.env.LA_PLUMA_WEBRTC_ICE_SERVERS = '';
process.env.LA_PLUMA_COPILOT_PROGRESS_STORE = join(fixtureDir, 'copilot-progress.json');
process.env.LA_PLUMA_ACTIVITY_COPILOT_PROGRESS_STORE = join(fixtureDir, 'activity-copilot-progress.json');

const { WEBRTC_SIGNALING_PATH } = await import('../../services/webrtcSignalingGateway.ts');
const { createLaPlumaApp } = await import('../../server.js');
const { default: agentRouter } = await import('../agent.js');
const agentExecutionRoutes = (await import('../agentExecution.js')).default;
const agentStatusRoutes = (await import('../agentStatusRoutes.js')).default;
const agentLogRoutes = (await import('../agentLogRoutes.js')).default;
const agentDataRoutes = (await import('../agentDataRoutes.js')).default;
const agentTrainingRoutes = (await import('../agentTrainingRoutes.ts')).default;
const agentPreviewRoutes = (await import('../agentPreviewRoutes.ts')).default;
const agentNotificationRoutes = (await import('../agentNotificationRoutes.ts')).default;
const agentMaintenanceRoutes = (await import('../agentMaintenanceRoutes.js')).default;
const { loggerManager } = await import('../../utils/logger.ts');

// 真实 HTTP 用例会触发服务日志；控制台输出关闭，避免门禁输出被诊断行淹没。
for (const loggerName of ['Api', 'MaaService', 'AgentRoutes', 'ConfigStorage']) {
  loggerManager.getLogger(loggerName).enableConsole = false;
}

// 维护入口迁出后，聚合 router 的完整对外清单必须与基线逐项一致。
const EXPECTED_ROUTES = [
  'DELETE /schedules/:scheduleId',
  'DELETE /training/queue/:operatorId',
  'GET /actions/discover-devices',
  'GET /activity',
  'GET /activity/copilot-candidates',
  'GET /activity/preflight',
  'GET /auto-update/status',
  'GET /changelog/cli',
  'GET /changelog/core',
  'GET /config-directory',
  'GET /config/maa/:profileName',
  'GET /copilot-sets/:id',
  'GET /copilot-sets/:id/plan',
  'GET /copilot/search',
  'GET /copilots/:id',
  'GET /data/depot',
  'GET /data/operators',
  'GET /data/operbox',
  'GET /debug-screenshots',
  'GET /device-stats',
  'GET /drops/recent',
  'GET /drops/statistics',
  'GET /drops/today',
  'GET /logs/files',
  'GET /logs/files/*filePath',
  'GET /logs/recent',
  'GET /manifest',
  'GET /notifications/config',
  'GET /openapi.json',
  'GET /paradox/operators',
  'GET /paradox/search',
  'GET /runs/:runId',
  'GET /runs/current',
  'GET /schedules/execution',
  'GET /schedules/status',
  'GET /stages/open-today',
  'GET /status',
  'GET /tasks/status',
  'GET /training/operators',
  'GET /training/queue',
  'GET /version',
  'GET /webrtc/devices',
  'GET /webrtc/status',
  'POST /actions/apply-training-plan',
  'POST /actions/configure-auto-update',
  'POST /actions/continue-copilot-set',
  'POST /actions/depot-recognition',
  'POST /actions/fetch-training-materials',
  'POST /actions/fight',
  'POST /actions/hot-update-resources',
  'POST /actions/open-config-directory',
  'POST /actions/operbox-recognition',
  'POST /actions/run-daily-flow',
  'POST /actions/run-task',
  'POST /actions/send-notification',
  'POST /actions/start-game',
  'POST /actions/stop',
  'POST /actions/test-connection',
  'POST /actions/test-notification-channel',
  'POST /actions/update-cli',
  'POST /actions/update-core',
  'POST /activity/run',
  'POST /config/maa/:profileName',
  'POST /copilot-sets/:id/execute',
  'POST /copilot-sets/:id/reset-progress',
  'POST /logs/cleanup',
  'POST /logs/recent/clear',
  'POST /notifications/config',
  'POST /preview/orientation',
  'POST /schedules',
  'POST /schedules/:scheduleId/execute',
  'POST /screen/screenshot',
  'POST /training/plan',
  'POST /training/queue',
  'POST /training/sync',
  'POST /webrtc/install',
  'POST /webrtc/start',
  'POST /webrtc/start-agent',
  'POST /webrtc/start-server',
  'POST /webrtc/stop',
  'POST /webrtc/stop-agent',
  'POST /webrtc/stop-server',
  'PUT /training/queue/order',
  'PUT /training/settings'
];

const MAINTENANCE_ROUTES = [
  ['GET', '/config/maa/:profileName'],
  ['POST', '/config/maa/:profileName'],
  ['GET', '/activity'],
  ['GET', '/activity/preflight'],
  ['GET', '/activity/copilot-candidates'],
  ['POST', '/actions/depot-recognition'],
  ['POST', '/actions/operbox-recognition'],
  ['GET', '/changelog/core'],
  ['GET', '/changelog/cli'],
  ['GET', '/copilots/:id'],
  ['GET', '/copilot-sets/:id'],
  ['GET', '/copilot-sets/:id/plan'],
  ['POST', '/copilot-sets/:id/reset-progress'],
  ['GET', '/paradox/search'],
  ['GET', '/copilot/search'],
  ['GET', '/paradox/operators'],
  ['GET', '/schedules/status'],
  ['GET', '/schedules/execution'],
  ['POST', '/schedules'],
  ['DELETE', '/schedules/:scheduleId'],
  ['POST', '/actions/configure-auto-update'],
  ['GET', '/auto-update/status'],
  ['POST', '/actions/open-config-directory'],
  ['POST', '/actions/update-core'],
  ['POST', '/actions/update-cli'],
  ['POST', '/actions/hot-update-resources'],
  ['POST', '/actions/test-connection'],
  ['GET', '/actions/discover-devices'],
  ['GET', '/version'],
  ['GET', '/config-directory']
];

const DOMAIN_ROUTERS = [
  agentStatusRoutes,
  agentPreviewRoutes,
  agentLogRoutes,
  agentExecutionRoutes,
  agentDataRoutes,
  agentTrainingRoutes,
  agentNotificationRoutes,
  agentMaintenanceRoutes
];

function flattenRoutes(routerInstance, routes = []) {
  for (const layer of routerInstance.stack) {
    if (layer.route) {
      for (const [method, enabled] of Object.entries(layer.route.methods ?? {})) {
        if (enabled) routes.push({ method: method.toUpperCase(), path: layer.route.path });
      }
      continue;
    }
    if (layer.handle?.stack) flattenRoutes(layer.handle, routes);
  }
  return routes;
}

function samplePath(path) {
  return path
    .split('/')
    .map(segment => segment.startsWith(':') ? 'sample' : segment.startsWith('*') ? 'sample.log' : segment)
    .join('/');
}

function patternMatcher(path) {
  const source = path
    .split('/')
    .map(segment => {
      if (segment.startsWith(':')) return '[^/]+';
      if (segment.startsWith('*')) return '.*';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${source}/?$`);
}

const servers = [];

async function listen(app) {
  const server = createServer(app);
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function stubSignalingGateway() {
  return {
    proxyPath: WEBRTC_SIGNALING_PATH,
    handleLogin(_req, res) {
      res.json({ token: 'stub' });
    }
  };
}

function authorizedHeaders() {
  return { Authorization: 'Bearer api-secret' };
}

async function callCliLog() {
  return await readFile(cliCallLog, 'utf-8').catch(() => '');
}

async function callAdbLog() {
  return await readFile(adbCallLog, 'utf-8').catch(() => '');
}

async function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

/** 出站端口经 text() 消费响应体；stub 返回 JSON 文本，零外部网络访问。 */
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body)
  };
}

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('agent router only aggregates domain routers', () => {
  it('keeps contract documents on the aggregator and mounts each domain router exactly once', () => {
    const topLevelRoutes = agentRouter.stack
      .filter(layer => layer.route)
      .flatMap(layer => Object.entries(layer.route.methods ?? {})
        .filter(([, enabled]) => enabled)
        .map(([method]) => `${method.toUpperCase()} ${layer.route.path}`))
      .sort();

    // 聚合入口只保留契约文档；副作用入口必须留在领域 router。
    assert.deepEqual(topLevelRoutes, ['GET /manifest', 'GET /openapi.json']);

    for (const domainRouter of DOMAIN_ROUTERS) {
      const mounts = agentRouter.stack.filter(layer => layer.handle === domainRouter);
      assert.equal(mounts.length, 1, 'each domain router must be mounted exactly once');
    }
  });

  it('keeps the mounted method/path inventory identical to the pre-split baseline', () => {
    const mounted = flattenRoutes(agentRouter);
    const keys = mounted.map(route => `${route.method} ${route.path}`);

    assert.equal(mounted.length, EXPECTED_ROUTES.length);
    assert.equal(new Set(keys).size, keys.length, 'mounted routes must be unique');
    assert.deepEqual([...keys].sort(), [...EXPECTED_ROUTES].sort());
  });

  it('keeps every baseline entry reachable without an earlier pattern shadowing it', () => {
    const mounted = flattenRoutes(agentRouter);

    for (const expected of EXPECTED_ROUTES) {
      const [method, path] = expected.split(' ');
      const target = samplePath(path);
      const firstMatch = mounted.find(route => route.method === method && patternMatcher(route.path).test(target));
      assert.ok(firstMatch, `missing mounted ${expected}`);
      assert.equal(firstMatch.path, path, `route order conflict: ${expected} is matched by ${firstMatch.method} ${firstMatch.path}`);
    }
  });

  it('mounts every remaining maintenance entry exactly once through the agent router', () => {
    const mounted = flattenRoutes(agentRouter);
    for (const [method, path] of MAINTENANCE_ROUTES) {
      const matches = mounted.filter(route => route.method === method && route.path === path);
      assert.equal(matches.length, 1, `expected exactly one mounted ${method} ${path}`);
    }
  });
});

describe('moved maintenance routes keep HTTP contracts', () => {
  it('rejects every moved maintenance entry before any CLI or ADB side effect', async () => {
    const port = await listen(createLaPlumaApp({
      env: { LA_PLUMA_TOKEN: 'api-secret' },
      signalingGateway: stubSignalingGateway(),
      loginRateLimit: { maxAuthFailures: 100 }
    }));
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;
    const requests = [
      ['GET', '/config/maa/default'],
      ['POST', '/config/maa/default'],
      ['GET', '/activity'],
      ['GET', '/activity/preflight'],
      ['GET', '/activity/copilot-candidates'],
      ['POST', '/actions/depot-recognition'],
      ['POST', '/actions/operbox-recognition'],
      ['GET', '/changelog/core'],
      ['GET', '/changelog/cli'],
      ['GET', '/copilots/1'],
      ['GET', '/copilot-sets/1'],
      ['GET', '/copilot-sets/1/plan'],
      ['POST', '/copilot-sets/1/reset-progress'],
      ['GET', '/paradox/search?name=x'],
      ['GET', '/copilot/search?stage=1-7'],
      ['GET', '/paradox/operators'],
      ['GET', '/schedules/status'],
      ['GET', '/schedules/execution'],
      ['POST', '/schedules'],
      ['DELETE', '/schedules/default'],
      ['POST', '/actions/configure-auto-update'],
      ['GET', '/auto-update/status'],
      ['POST', '/actions/open-config-directory'],
      ['POST', '/actions/update-core'],
      ['POST', '/actions/update-cli'],
      ['POST', '/actions/hot-update-resources'],
      ['POST', '/actions/test-connection'],
      ['GET', '/actions/discover-devices'],
      ['GET', '/version'],
      ['GET', '/config-directory']
    ];

    for (const [method, path] of requests) {
      const response = await fetch(`${baseUrl}${path}`, { method });
      assert.equal(response.status, 401, `${method} ${path} must require the API token`);
      const body = await response.json();
      assert.equal(body.error.code, 'AGENT_AUTH_REQUIRED');
    }

    assert.equal(await callCliLog(), '');
    assert.equal(await callAdbLog(), '');
  });

  it('serves version, config directory and schedule status from the existing sources', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;

    const version = await (await fetch(`${baseUrl}/version`)).json();
    assert.equal(version.success, true);
    assert.equal(version.data.cli, 'v0.7.0');
    assert.equal(version.data.core, 'v6.2.3');
    assert.equal(version.data.resource.status, 'current');

    const configDir = await (await fetch(`${baseUrl}/config-directory`)).json();
    assert.equal(configDir.success, true);
    assert.equal(configDir.data.path, maaConfigDir);

    const scheduleStatus = await (await fetch(`${baseUrl}/schedules/status`)).json();
    assert.equal(scheduleStatus.success, true);
    assert.equal(typeof scheduleStatus.data, 'object');

    const execution = await (await fetch(`${baseUrl}/schedules/execution`)).json();
    assert.equal(execution.success, true);
    assert.equal(execution.data.isRunning, false);

    const autoUpdate = await (await fetch(`${baseUrl}/auto-update/status`)).json();
    assert.equal(autoUpdate.success, true);
    assert.equal(typeof autoUpdate.data, 'object');
  });

  it('keeps connection test and device discovery on the existing ADB contract', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;

    const testConnection = await postJson(`${baseUrl}/actions/test-connection`, {
      adbPath: fakeAdbPath,
      address: '127.0.0.1:5555'
    });
    assert.equal(testConnection.status, 200);
    const tested = await testConnection.json();
    assert.equal(tested.success, true);
    assert.equal(tested.data.connected, true);
    assert.match(await callAdbLog(), /^connect 127\.0\.0\.1:5555$/m);

    const discover = await fetch(`${baseUrl}/actions/discover-devices?adbPath=${encodeURIComponent(fakeAdbPath)}`);
    assert.equal(discover.status, 200);
    const discovered = await discover.json();
    assert.equal(discovered.success, true);
    assert.ok(Array.isArray(discovered.data.devices));
  });

  it('returns dry-run plans without starting updates or recognition', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;
    const cliBefore = await callCliLog();
    const adbBefore = await callAdbLog();

    const core = await postJson(`${baseUrl}/actions/update-core`, { dryRun: true, version: 'beta' });
    const coreBody = await core.json();
    assert.equal(coreBody.success, true);
    assert.equal(coreBody.data.plan.action, 'update-core-and-resources');
    assert.equal(coreBody.data.plan.steps[0].targetChannel, 'beta');
    assert.equal(coreBody.meta.dryRun, true);

    const cli = await postJson(`${baseUrl}/actions/update-cli`, { dryRun: true });
    const cliBody = await cli.json();
    assert.equal(cliBody.success, true);
    assert.equal(cliBody.data.plan.action, 'update-cli');

    const resources = await postJson(`${baseUrl}/actions/hot-update-resources`, { dryRun: true });
    const resourceBody = await resources.json();
    assert.equal(resourceBody.success, true);
    assert.equal(resourceBody.data.plan.action, 'hot-update-resources');

    for (const action of ['depot-recognition', 'operbox-recognition']) {
      const response = await postJson(`${baseUrl}/actions/${action}`, { dryRun: true });
      const body = await response.json();
      assert.equal(body.success, true, action);
      assert.equal(body.data.plan.action, action);
    }

    // dryRun 只返回计划：不能隐式触发 MAA 更新或识别动作的解析/缓存写入。
    assert.equal(await callCliLog(), cliBefore);
    assert.equal(await callAdbLog(), adbBefore);
  });

  it('keeps profile read and write on the MAA config directory', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;

    const saved = await postJson(`${baseUrl}/config/maa/default`, {
      connection: { adb_path: '/opt/adb', address: '127.0.0.1:6000' }
    });
    const savedBody = await saved.json();
    assert.equal(savedBody.success, true);
    assert.equal(savedBody.message, '配置保存成功');

    const read = await (await fetch(`${baseUrl}/config/maa/default`)).json();
    assert.equal(read.success, true);
    assert.equal(read.data.adb_path, '/opt/adb');
    assert.equal(read.data.address, '127.0.0.1:6000');
    assert.match(await readFile(join(maaConfigDir, 'profiles', 'default.toml'), 'utf-8'), /127\.0\.0\.1:6000/);
  });

  it('keeps the profile name validation contract for save requests', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;

    const response = await postJson(`${baseUrl}/config/maa/-invalid`, { connection: {} });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'AGENT_INTERNAL_ERROR');
    // 非法 profile 名在写入前被拒绝：错误响应走统一出口，不落盘。
    await assert.rejects(readFile(join(maaConfigDir, 'profiles', '-invalid.toml'), 'utf-8'), { code: 'ENOENT' });
  });

  it('resolves the copilot set plan through the existing plan service', async t => {
    const realFetch = globalThis.fetch;
    const outboundCalls = [];
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === '127.0.0.1') return realFetch(input, init);
      outboundCalls.push(url.href);
      if (url.pathname === '/set/get') {
        return jsonResponse({ status_code: 200, data: { id: '42', name: 'fixture set', copilot_ids: [100] } });
      }
      if (url.pathname === '/copilot/get/100') {
        return jsonResponse({
          status_code: 200,
          data: {
            id: 100,
            content: JSON.stringify({ stage_name: 'main_01-07', doc: { title: '1-7 测试' }, opers: [{ name: 'Amiya' }] })
          }
        });
      }
      throw new Error(`unexpected outbound request: ${url.href}`);
    });

    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;

    const response = await fetch(`${baseUrl}/copilot-sets/42/plan?raid=normal`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.data.setId, '42');
    assert.equal(body.data.name, 'fixture set');
    assert.equal(body.data.entries.length, 1);
    assert.equal(body.data.entries[0].copilotId, 100);
    assert.deepEqual(outboundCalls.map(url => new URL(url).pathname), ['/set/get', '/copilot/get/100']);
  });
});
