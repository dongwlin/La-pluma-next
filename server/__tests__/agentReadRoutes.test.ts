import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import type { ApiErrorResponse, ApiSuccessResponse } from '../utils/apiHelper.ts';
import type { AgentStatusPayload } from '../controllers/readDto.ts';
import type { AgentRunSnapshot } from '../services/runSnapshotService.ts';
import type { MaaTaskStatus } from '../services/maaProcessService.ts';
import type { MaaLogFileContent, MaaLogFileEntry } from '../services/maaLogFileService.ts';
import type { DropRecordDay, DropStatistics } from '../services/dropRecordService.ts';
import type { DailyStageOverview } from '../services/notificationService.ts';
import type { DepotFile, OperBoxFile, OperatorSummary } from '../services/dataParserService.ts';
import type { WebrtcSignalingGateway } from '../services/webrtcSignalingGateway.ts';

// 真实 HTTP 回归：状态、Run 查询、日志、掉落与游戏数据读取已从 agent.ts
// 拆到独立 router，这里通过 createLaPlumaApp 验证挂载、鉴权、query 归一化、
// 日志路径与生产静态 fallback 顺序保持不变。
// 环境变量必须在导入被测模块前就绪：MAA_CLI_PATH 与 XDG_* 由服务在导入或
// 调用时读取，测试只使用临时目录与假 CLI / 假 ADB，不触碰真实设备。
//
// 响应按各端点声明的 DTO 读取：状态汇总的探测兜底与成功投影分别收窄，
// Run 快照直接复用 runSnapshotService 的快照类型，掉落与游戏数据复用领域类型。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-read-routes-'));
const maaLogDir = join(fixtureDir, 'maa-logs');
const dropDir = join(fixtureDir, 'drop-records');
const xdgDataHome = join(fixtureDir, 'xdg-data');
const xdgStateHome = join(fixtureDir, 'xdg-state');
const xdgConfigHome = join(fixtureDir, 'xdg-config');
const resourceDir = join(xdgDataHome, 'maa', 'resource');
const maaCacheDir = join(fixtureDir, 'maa-cache');
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');
const fakeAdbPath = join(fixtureDir, 'fake-adb.js');
const adbCallLog = join(fixtureDir, 'adb-calls.log');
const adbConnectedMarker = join(fixtureDir, 'adb-connected');
const logFilePath = join(maaLogDir, 'run.log');

await mkdir(maaLogDir, { recursive: true });
await mkdir(dropDir, { recursive: true });
await mkdir(resourceDir, { recursive: true });
await mkdir(maaCacheDir, { recursive: true });
await writeFile(join(resourceDir, 'battle_data.json'), JSON.stringify({
  chars: {
    char_002_amiya: { name: '阿米娅', rarity: 4, profession: 'CASTER', position: 'RANGED' }
  }
}));
// 活动表只给美服一个长期开放窗口，用于验证资源全开放投影不改变其它服务区。
await writeFile(join(maaCacheDir, 'StageActivityV2.json'), JSON.stringify({
  Official: {},
  YoStarEN: {
    resourceCollection: {
      Tip: 'SUPPLIES & CHIPS EVERYDAY ACCESS',
      UtcStartTime: '2020/01/01 00:00:00',
      UtcExpireTime: '2030/01/01 00:00:00',
      TimeZone: 0,
      IsResourceCollection: true
    }
  }
}));
await writeFile(logFilePath, 'line one\nline two', 'utf-8');

await writeFile(fakeCliPath, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'version') {
  process.stdout.write('maa-cli v0.7.0\\nMaaCore v6.2.3\\n');
} else if (args[0] === 'dir' && args[1] === 'log') {
  process.stdout.write(process.env.FAKE_MAA_LOG_DIR || '');
} else if (args[0] === 'dir' && args[1] === 'config') {
  process.stdout.write(process.env.FAKE_MAA_CONFIG_DIR || '');
} else if (args[0] === 'dir' && args[1] === 'cache') {
  process.stdout.write(process.env.FAKE_MAA_CACHE_DIR || '');
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
} else if (args[0] === '-s') {
  const shellIndex = args.indexOf('shell');
  const command = shellIndex >= 0 ? args.slice(shellIndex + 1).join(' ') : '';
  if (command.startsWith('dumpsys window')) process.stdout.write('mCurrentFocus=Window{1a2b com.example/.MainActivity}\\n');
  else if (command.startsWith('dumpsys display')) process.stdout.write('real 1080 x 1920\\nmCurrentOrientation=0\\n');
  else if (command.startsWith('settings get')) process.stdout.write('0\\n');
  else process.stdout.write('');
} else {
  process.exit(0);
}
`, { mode: 0o755 });

process.env.MAA_CLI_PATH = fakeCliPath;
process.env.ADB_PATH = fakeAdbPath;
process.env.FAKE_MAA_LOG_DIR = maaLogDir;
process.env.FAKE_MAA_CONFIG_DIR = join(xdgConfigHome, 'maa');
process.env.FAKE_MAA_CACHE_DIR = maaCacheDir;
process.env.MAA_CACHE_DIR = maaCacheDir;
process.env.FAKE_ADB_LOG = adbCallLog;
process.env.FAKE_ADB_CONNECTED = adbConnectedMarker;
process.env.FAKE_ADB_ADDRESS = '127.0.0.1:5555';
process.env.XDG_DATA_HOME = xdgDataHome;
process.env.XDG_STATE_HOME = xdgStateHome;
process.env.XDG_CONFIG_HOME = xdgConfigHome;
process.env.LA_PLUMA_DROP_RECORDS_DIR = dropDir;
process.env.LA_PLUMA_AGENT_RUN_STORE = join(fixtureDir, 'agent-runs.json');
process.env.LA_PLUMA_MAA_LOCK_FILE = join(fixtureDir, 'maa-execution.lock');
process.env.LA_PLUMA_WEBRTC_DIR = join(fixtureDir, 'webrtc');
process.env.LA_PLUMA_WEBRTC_ICE_SERVERS = '';

const { WEBRTC_SIGNALING_PATH } = await import('../services/webrtcSignalingGateway.ts');
const { createLaPlumaApp } = await import('../app.ts');
const { resetAgentStatusProbeCacheForTests } = await import('../controllers/agentStatusController.ts');
const { getLocalDateString } = await import('../services/dropRecordService.ts');
const { getGameDay } = await import('../services/gameCalendar.ts');
const { DEFAULT_CLIENT_TYPE } = await import('../config/connectionDefaults.ts');
const { loggerManager } = await import('../utils/logger.ts');

// 真实 HTTP 用例会触发服务日志；控制台输出关闭，避免门禁输出被诊断行淹没。
for (const loggerName of ['Api', 'MaaService', 'DropRecord', 'DataParser']) {
  loggerManager.getLogger(loggerName).enableConsole = false;
}

const servers: Server[] = [];

async function listen(app: ReturnType<typeof createLaPlumaApp>): Promise<number> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

/** 信令网关桩：应用只读取 proxyPath 与登录入口，本文件不建立 WebRTC 连接。 */
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

interface ApiEnvelopeLike {
  success: boolean;
}

function isApiEnvelope(value: unknown): value is ApiEnvelopeLike {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as { success?: unknown }).success === 'boolean';
}

/** fetch 的 JSON 载荷是 unknown；先确认统一信封，再按端点声明的 DTO 读取。 */
async function readBody<T>(response: Response): Promise<T> {
  const body: unknown = await response.json();
  assert.ok(isApiEnvelope(body));
  return body as T;
}

async function readErrorBody(response: Response): Promise<ApiErrorResponse> {
  const body = await readBody<ApiErrorResponse>(response);
  assert.equal(body.success, false);
  return body;
}

function authorizedHeaders(): Record<string, string> {
  return { Authorization: 'Bearer api-secret' };
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

describe('moved agent read routes keep authentication and response contracts', () => {
  it('rejects every moved route before probing devices when the API token is missing', async () => {
    const port = await listen(createLaPlumaApp({
      env: { LA_PLUMA_TOKEN: 'api-secret' },
      signalingGateway: stubSignalingGateway(),
      // 单个用例按路由清单逐个验证鉴权，放宽失败限流以免中途变成 429。
      loginRateLimit: { maxAuthFailures: 100 }
    }));
    const baseUrl = `http://127.0.0.1:${port}`;
    const movedRoutes: ReadonlyArray<readonly [string, string]> = [
      ['GET', `/api/agent/status?adbPath=${encodeURIComponent(fakeAdbPath)}&address=127.0.0.1:5555`],
      ['GET', '/api/agent/runs/current'],
      ['GET', '/api/agent/runs/00000000-0000-4000-8000-000000000000'],
      ['GET', '/api/agent/tasks/status'],
      ['GET', '/api/agent/logs/recent'],
      ['POST', '/api/agent/logs/recent/clear'],
      ['GET', '/api/agent/debug-screenshots'],
      ['GET', '/api/agent/logs/files'],
      ['GET', '/api/agent/logs/files/run.log'],
      ['POST', '/api/agent/logs/cleanup'],
      ['GET', '/api/agent/stages/open-today'],
      ['GET', '/api/agent/drops/today'],
      ['GET', '/api/agent/drops/recent'],
      ['GET', '/api/agent/drops/statistics'],
      ['GET', '/api/agent/data/depot'],
      ['GET', '/api/agent/data/operbox'],
      ['GET', '/api/agent/data/operators']
    ];

    for (const [method, path] of movedRoutes) {
      const response = await fetch(`${baseUrl}${path}`, { method });
      assert.equal(response.status, 401, `${method} ${path} must require the API token`);
      const body = await readErrorBody(response);
      assert.equal(body.error.code, 'AGENT_AUTH_REQUIRED');
    }
  });

  it('serves status with the existing aggregate shape and performs the ADB connection probe', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const query = new URLSearchParams({
      adbPath: fakeAdbPath,
      address: '127.0.0.1:5555'
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/agent/status?${query}`);
    assert.equal(response.status, 200);
    const body = await readBody<ApiSuccessResponse<AgentStatusPayload>>(response);

    assert.equal(body.success, true);
    assert.equal(body.data.api.name, 'la-pluma-agent-api');
    assert.equal(body.data.api.manifest, '/api/agent/manifest');
    const version = body.data.maa.version;
    assert.ok('cli' in version);
    assert.equal(version.cli, 'v0.7.0');
    assert.equal(body.data.maa.task.isRunning, false);
    const device = body.data.device;
    assert.equal(device.adbPath, fakeAdbPath);
    assert.equal(device.address, '127.0.0.1:5555');
    assert.equal(device.connected, true);
    assert.ok('foreground' in device);
    assert.ok(device.foreground);
    assert.match(device.foreground, /MainActivity/);
    const orientation = body.data.screen.orientation;
    assert.ok('width' in orientation);
    assert.equal(orientation.width, 1080);
    assert.equal(orientation.height, 1920);
    assert.ok(Array.isArray(body.data.recentLogs));
    assert.ok(Array.isArray(body.data.recommendations));

    // /status 汇总会连接 ADB；这里锁定该副作用仍由状态探测边界承担，
    // 不能把状态路由当成纯读取或设备空闲的证据。
    const adbCalls = await readFile(adbCallLog, 'utf-8');
    assert.match(adbCalls, /^connect 127\.0\.0\.1:5555$/m);
  });

  it('caches and coalesces status probes for the same device', async () => {
    resetAgentStatusProbeCacheForTests();
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const query = new URLSearchParams({
      adbPath: fakeAdbPath,
      address: '127.0.0.1:5555'
    });
    const url = `http://127.0.0.1:${port}/api/agent/status?${query}`;
    const adbCalls = async (): Promise<string[]> => (
      (await readFile(adbCallLog, 'utf-8')).trim().split('\n').filter(Boolean)
    );

    await writeFile(adbCallLog, '');
    const first = await readBody<ApiSuccessResponse<AgentStatusPayload>>(await fetch(url));
    const afterFirst = await adbCalls();
    assert.equal(afterFirst.filter(line => line === 'version').length, 1);

    // TTL 内的第二个请求复用四项外部探测，不再启动 ADB。
    const second = await readBody<ApiSuccessResponse<AgentStatusPayload>>(await fetch(url));
    assert.deepEqual(await adbCalls(), afterFirst);
    assert.deepEqual(second.data.device, first.data.device);
    assert.deepEqual(second.data.screen, first.data.screen);

    // 并发突发共享同一次在途探测，而不是每个请求各跑一遍 ADB。
    resetAgentStatusProbeCacheForTests();
    await writeFile(adbCallLog, '');
    await Promise.all([fetch(url), fetch(url), fetch(url)]);
    const concurrentCalls = await adbCalls();
    assert.equal(concurrentCalls.filter(line => line === 'version').length, 1);

    resetAgentStatusProbeCacheForTests();
  });

  it('keeps Run query composition and the unknown-run error mapping', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const baseUrl = `http://127.0.0.1:${port}`;

    const snapshot = await readBody<ApiSuccessResponse<AgentRunSnapshot>>(
      await fetch(`${baseUrl}/api/agent/runs/current?lines=1`)
    );
    assert.equal(snapshot.success, true);
    assert.equal(snapshot.data.isRunning, false);
    assert.equal(snapshot.data.run, null);
    assert.deepEqual(snapshot.data.activeRuns, []);
    assert.equal(snapshot.data.lastRun, null);
    assert.equal(snapshot.data.occupancy.state, 'idle');
    assert.ok(Array.isArray(snapshot.data.recentLogs));
    assert.ok(snapshot.data.schedule);

    const task = await readBody<ApiSuccessResponse<MaaTaskStatus>>(
      await fetch(`${baseUrl}/api/agent/tasks/status`)
    );
    assert.equal(task.success, true);
    assert.equal(typeof task.data.isRunning, 'boolean');

    const missing = await fetch(`${baseUrl}/api/agent/runs/00000000-0000-4000-8000-000000000000`);
    assert.equal(missing.status, 404);
    const missingBody = await readErrorBody(missing);
    assert.equal(missingBody.error.code, 'AGENT_RUN_NOT_FOUND');
    assert.deepEqual(missingBody.error.details, { runId: '00000000-0000-4000-8000-000000000000' });
    assert.equal(missingBody.error.retryable, false);
  });

  it('keeps log listing, single decoding and the line cap over real HTTP', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const baseUrl = `http://127.0.0.1:${port}`;

    const recent = await readBody<ApiSuccessResponse<unknown[]>>(
      await fetch(`${baseUrl}/api/agent/logs/recent?lines=2`)
    );
    assert.equal(recent.success, true);
    assert.ok(Array.isArray(recent.data));

    const listing = await readBody<ApiSuccessResponse<MaaLogFileEntry[]>>(
      await fetch(`${baseUrl}/api/agent/logs/files`)
    );
    assert.equal(listing.success, true);
    assert.ok(listing.data.some(file => file.name === 'run.log'));

    const read = await readBody<ApiSuccessResponse<MaaLogFileContent>>(
      await fetch(`${baseUrl}/api/agent/logs/files/${encodeURIComponent(logFilePath)}?lines=1`)
    );
    assert.equal(read.success, true);
    assert.equal(read.data.returnedLines, 1);
    assert.equal(read.data.content, 'line two');

    const escaped = await readErrorBody(
      await fetch(`${baseUrl}/api/agent/logs/files/${encodeURIComponent('../outside.log')}`)
    );
    assert.equal(escaped.success, false);
    assert.equal(escaped.error.code, 'AGENT_INTERNAL_ERROR');
  });

  it('keeps log maintenance validation and debug screenshot reads', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const baseUrl = `http://127.0.0.1:${port}`;

    const cleared = await readBody<ApiSuccessResponse<null>>(
      await fetch(`${baseUrl}/api/agent/logs/recent/clear`, { method: 'POST' })
    );
    assert.equal(cleared.success, true);
    assert.equal(cleared.message, '实时日志已清空');

    const invalidCleanup = await fetch(`${baseUrl}/api/agent/logs/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxSizeMB: 0 })
    });
    assert.equal(invalidCleanup.status, 400);
    const invalidBody = await readErrorBody(invalidCleanup);
    assert.equal(invalidBody.error.code, 'AGENT_VALIDATION_LOG_SIZE_INVALID');
    assert.deepEqual(invalidBody.error.details, { maxSizeMB: 0 });

    const screenshots = await readBody<ApiSuccessResponse<unknown[]>>(
      await fetch(`${baseUrl}/api/agent/debug-screenshots`)
    );
    assert.equal(screenshots.success, true);
  });

  it('keeps drops, stage and game data reads on their existing response shapes', async () => {
    const date = getLocalDateString(new Date());
    await writeFile(join(dropDir, `${date}.json`), JSON.stringify({
      date,
      records: [],
      summary: { totalSanity: 0, totalMedicine: 0, totalStone: 0, totalBattles: 0, itemsSummary: {} }
    }), 'utf-8');
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const baseUrl = `http://127.0.0.1:${port}`;

    const recentDrops = await readBody<ApiSuccessResponse<DropRecordDay[]>>(
      await fetch(`${baseUrl}/api/agent/drops/recent?days=2`)
    );
    assert.equal(recentDrops.success, true);
    assert.equal(recentDrops.data.length, 1);
    assert.equal(recentDrops.data[0].date, date);

    const todayDrops = await readBody<ApiSuccessResponse<DropRecordDay>>(
      await fetch(`${baseUrl}/api/agent/drops/today`)
    );
    assert.equal(todayDrops.success, true);

    const statistics = await readBody<ApiSuccessResponse<DropStatistics>>(
      await fetch(`${baseUrl}/api/agent/drops/statistics?days=2`)
    );
    assert.equal(statistics.success, true);
    assert.equal(statistics.data.dateRange.days, 1);
    assert.equal(statistics.data.dailyTrend.length, 1);

    const stages = await readBody<ApiSuccessResponse<DailyStageOverview>>(
      await fetch(`${baseUrl}/api/agent/stages/open-today`)
    );
    assert.equal(stages.success, true);
    assert.ok(Array.isArray(stages.data.open));
    assert.ok(Array.isArray(stages.data.closed));

    const operators = await readBody<ApiSuccessResponse<OperatorSummary[]>>(
      await fetch(`${baseUrl}/api/agent/data/operators`)
    );
    assert.equal(operators.success, true);
    assert.deepEqual(operators.data.map(operator => operator.id), ['char_002_amiya']);

    const depot = await readBody<ApiSuccessResponse<DepotFile | null>>(
      await fetch(`${baseUrl}/api/agent/data/depot`)
    );
    assert.equal(depot.success, true);
    const operbox = await readBody<ApiSuccessResponse<OperBoxFile | null>>(
      await fetch(`${baseUrl}/api/agent/data/operbox`)
    );
    assert.equal(operbox.success, true);
  });

  it('judges open-today stages in the requested client game day', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const baseUrl = `http://127.0.0.1:${port}`;

    // 游戏日在 04:00 边界切换；读取前后各取一次，跨边界时只要求落在其中一天。
    const before = getGameDay(new Date(), 'YoStarJP');
    const response = await fetch(`${baseUrl}/api/agent/stages/open-today?clientType=YoStarJP`);
    assert.equal(response.status, 200);
    const japanese = await readBody<ApiSuccessResponse<DailyStageOverview>>(response);
    const after = getGameDay(new Date(), 'YoStarJP');

    assert.equal(japanese.success, true);
    assert.equal(japanese.data.clientType, 'YoStarJP');
    if (before.date === after.date) {
      assert.equal(japanese.data.gameDate, before.date);
      assert.equal(japanese.data.weekday, before.weekday);
    } else {
      assert.ok([before.date, after.date].includes(japanese.data.gameDate));
    }
    assert.equal(
      new Date(`${japanese.data.gameDate}T00:00:00.000Z`).getUTCDay(),
      japanese.data.weekday,
      'weekday must be the game-day weekday of gameDate'
    );

    const profile = await readBody<ApiSuccessResponse<DailyStageOverview>>(
      await fetch(`${baseUrl}/api/agent/stages/open-today`)
    );
    assert.equal(profile.data.clientType, DEFAULT_CLIENT_TYPE);
  });

  it('projects every resource stage as open during a server-zone resource collection window', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const baseUrl = `http://127.0.0.1:${port}`;

    const english = await readBody<ApiSuccessResponse<DailyStageOverview>>(
      await fetch(`${baseUrl}/api/agent/stages/open-today?clientType=YoStarEN`)
    );
    assert.equal(english.success, true);
    assert.equal(english.data.clientType, 'YoStarEN');
    assert.deepEqual(english.data.closed, []);
    assert.deepEqual(
      english.data.open.map(stage => stage.stage).sort(),
      ['AP-5', 'CA-5', 'CE-6', 'LS-6', 'PR-A', 'PR-B', 'PR-C', 'PR-D', 'SK-5']
    );

    // 同一时刻其它服务区没有全开放窗口，仍按周表投影：任意游戏日都至少有一个资源本关闭。
    const japanese = await readBody<ApiSuccessResponse<DailyStageOverview>>(
      await fetch(`${baseUrl}/api/agent/stages/open-today?clientType=YoStarJP`)
    );
    assert.ok(japanese.data.closed.length > 0);
    assert.deepEqual(
      [...japanese.data.open, ...japanese.data.closed].map(stage => stage.stage).sort(),
      ['AP-5', 'CA-5', 'CE-6', 'LS-6', 'PR-A', 'PR-B', 'PR-C', 'PR-D', 'SK-5']
    );
  });

  it('keeps production static fallback behind the moved API routes', async () => {
    const clientDistPath = join(fixtureDir, 'client-dist');
    await mkdir(clientDistPath, { recursive: true });
    await writeFile(join(clientDistPath, 'index.html'), '<!doctype html><title>La Pluma Next fixture</title>', 'utf-8');
    const port = await listen(createLaPlumaApp({
      env: { NODE_ENV: 'production', LA_PLUMA_TOKEN: 'api-secret' },
      signalingGateway: stubSignalingGateway(),
      clientDistPath
    }));
    const baseUrl = `http://127.0.0.1:${port}`;

    const unauthenticated = await fetch(`${baseUrl}/api/agent/logs/recent`);
    assert.equal(unauthenticated.status, 401);
    assert.match(unauthenticated.headers.get('content-type') || '', /application\/json/);

    const logs = await fetch(`${baseUrl}/api/agent/logs/recent`, { headers: authorizedHeaders() });
    assert.equal(logs.status, 200);
    assert.match(logs.headers.get('content-type') || '', /application\/json/);
    const logsBody = await readBody<ApiSuccessResponse<unknown[]>>(logs);
    assert.equal(logsBody.success, true);

    const missing = await fetch(`${baseUrl}/api/agent/nonexistent-endpoint`, { headers: authorizedHeaders() });
    assert.equal(missing.status, 404);
    const missingBody = await readErrorBody(missing);
    assert.equal(missingBody.error.code, 'AGENT_ROUTE_NOT_FOUND');

    const shell = await fetch(`${baseUrl}/logs`);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /La Pluma Next fixture/);
  });
});
