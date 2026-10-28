import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { ApiErrorResponse, ApiSuccessResponse } from '../../utils/apiHelper.ts';
import type { MaintenanceUpdateCliPlan, MaintenanceUpdateCorePlan } from '../maintenanceDto.ts';

// 剩余维护入口已从 agent.js 拆到独立 router：这里先按实际挂载关系核对
// 完整路由清单与顺序，再通过 createLaPlumaApp 验证真实 HTTP 的鉴权、
// 连接覆盖、dryRun 与平台信息契约。所有外部依赖都用假 CLI / 假 ADB
// 或临时目录，不触碰真实设备与资源更新。
//
// 生产路由已类型化，本文件同步转为 TS：请求收窄、dryRun 与更新渠道、
// 定时注册与自动更新配置的边界与实现共用同一 DTO；非法输入用例同时
// 断言不产生 CLI/ADB 调用、不写 profile、不发起出站请求。
//
// DTO 在 env 注入后再动态导入：connectionDefaults 在模块加载时读取
// MAA_CLI_PATH，静态值导入会让假 CLI 路径失效。
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

const { createLaPlumaApp } = await import('../../server.js');
const {
  parseAutoUpdateBody,
  parseCopilotPlanQuery,
  parseCopilotSearchQuery,
  parseDryRunBody,
  parseGithubReleaseList,
  parseMaaProfileBody,
  parseParadoxSearchQuery,
  parsePrtsCopilotQueryPayload,
  parseScheduleSetupBody,
  parseUpdateCoreBody,
  projectCopilotSearchItem,
  projectParadoxCopilot,
  resourceInfoFallback,
  toChangelogEntry
} = await import('../maintenanceDto.ts');
const { default: agentRouter } = await import('../agent.js');
const agentExecutionRoutes = (await import('../agentExecution.ts')).default;
const agentStatusRoutes = (await import('../agentStatusRoutes.ts')).default;
const agentLogRoutes = (await import('../agentLogRoutes.ts')).default;
const agentDataRoutes = (await import('../agentDataRoutes.ts')).default;
const agentTrainingRoutes = (await import('../agentTrainingRoutes.ts')).default;
const agentPreviewRoutes = (await import('../agentPreviewRoutes.ts')).default;
const agentNotificationRoutes = (await import('../agentNotificationRoutes.ts')).default;
const agentMaintenanceRoutes = (await import('../agentMaintenanceRoutes.ts')).default;
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

const MAINTENANCE_ROUTES: ReadonlyArray<readonly [string, string]> = [
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

const DOMAIN_ROUTERS: unknown[] = [
  agentStatusRoutes,
  agentPreviewRoutes,
  agentLogRoutes,
  agentExecutionRoutes,
  agentDataRoutes,
  agentTrainingRoutes,
  agentNotificationRoutes,
  agentMaintenanceRoutes
];

interface MountedRouteLayer {
  route?: { path: string; methods?: Record<string, boolean> };
  handle?: MountedRouteLayer;
}

interface MountedRoute {
  method: string;
  path: string;
}

/** HTTP 响应用到的载荷投影：只声明用例实际读取的字段，其余保持不校验。 */
interface VersionPayload {
  cli: string;
  core: string;
  resource: { status: string };
}

interface ConfigDirectoryPayload {
  path: string;
}

interface ScheduleExecutionPayload {
  isRunning: boolean;
}

interface TestConnectionPayload {
  connected: boolean;
}

interface DiscoveryPayload {
  devices: unknown[];
}

interface AutoUpdateStatusPayload {
  enabled: boolean;
  time: string | null;
}

interface UpdateCorePayload {
  plan: MaintenanceUpdateCorePlan;
}

interface UpdateCliPayload {
  plan: MaintenanceUpdateCliPlan;
}

interface DryRunPlanPayload {
  plan: { action: string };
}

interface ProfilePayload {
  adb_path: unknown;
  address: unknown;
}

interface CopilotPlanPayload {
  setId: string;
  name: string;
  entries: Array<{ copilotId: number }>;
}


function routerStack(routerInstance: unknown): MountedRouteLayer[] {
  return (routerInstance as { stack?: MountedRouteLayer[] }).stack ?? [];
}

function flattenRoutes(routerInstance: unknown, routes: MountedRoute[] = []): MountedRoute[] {
  for (const layer of routerStack(routerInstance)) {
    if (layer.route) {
      for (const [method, enabled] of Object.entries(layer.route.methods ?? {})) {
        if (enabled) routes.push({ method: method.toUpperCase(), path: layer.route.path });
      }
      continue;
    }
    if (layer.handle) flattenRoutes(layer.handle, routes);
  }
  return routes;
}

function topLevelRouteKeys(routerInstance: unknown): string[] {
  const keys: string[] = [];
  for (const layer of routerStack(routerInstance)) {
    if (!layer.route) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods ?? {})) {
      if (enabled) keys.push(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return keys.sort();
}

function samplePath(path: string): string {
  return path
    .split('/')
    .map(segment => segment.startsWith(':') ? 'sample' : segment.startsWith('*') ? 'sample.log' : segment)
    .join('/');
}

function patternMatcher(path: string): RegExp {
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

const servers: Server[] = [];

function isApiSuccess(value: unknown): value is ApiSuccessResponse<unknown> {
  return typeof value === 'object'
    && value !== null
    && (value as { success?: unknown }).success === true;
}

function isApiError(value: unknown): value is ApiErrorResponse {
  return typeof value === 'object'
    && value !== null
    && (value as { success?: unknown }).success === false;
}

/** fetch 的 JSON 载荷是 unknown；先确认统一信封，再按端点声明的 DTO 读取。 */
async function readSuccess<T>(response: Response): Promise<ApiSuccessResponse<T>> {
  const body: unknown = await response.json();
  assert.ok(isApiSuccess(body), `unexpected API envelope: ${JSON.stringify(body)}`);
  return body as ApiSuccessResponse<T>;
}

async function readError(response: Response): Promise<ApiErrorResponse> {
  const body: unknown = await response.json();
  assert.ok(isApiError(body));
  return body;
}

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

async function callCliLog(): Promise<string> {
  return await readFile(cliCallLog, 'utf-8').catch(() => '');
}

async function callAdbLog(): Promise<string> {
  return await readFile(adbCallLog, 'utf-8').catch(() => '');
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

/** 出站端口经 text() 消费响应体；stub 返回 JSON 文本，零外部网络访问。 */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body)
  } as unknown as Response;
}

/**
 * 运行时出站守卫：只允许用例自身的 127.0.0.1 回环请求，其他地址记录后失败。
 * 经 t.mock.method 安装并在用例结束恢复，不在源码层改写全局 fetch 声明。
 */
function guardOutboundFetch(t: TestContext): { external: string[] } {
  const realFetch = globalThis.fetch;
  const external: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.hostname !== '127.0.0.1') {
      external.push(url.href);
      throw new Error(`unexpected outbound request: ${url.host}`);
    }
    return realFetch(input, init);
  });
  return { external };
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

describe('agent router only aggregates domain routers', () => {
  it('keeps contract documents on the aggregator and mounts each domain router exactly once', () => {
    // 聚合入口只保留契约文档；副作用入口必须留在领域 router。
    assert.deepEqual(topLevelRouteKeys(agentRouter), ['GET /manifest', 'GET /openapi.json']);

    for (const domainRouter of DOMAIN_ROUTERS) {
      const mounts = routerStack(agentRouter).filter(layer => layer.handle === domainRouter);
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

describe('maintenance request narrowing', () => {
  it('keeps the raw profile body for the config owner to validate', () => {
    const payload = { connection: { adb_path: '/opt/adb' } };
    assert.equal(parseMaaProfileBody(payload), payload);
    for (const body of [undefined, null, 0, '', false]) {
      assert.deepEqual(parseMaaProfileBody(body), {});
    }
    // 真值非对象保持原值，继续由 maaConfigService 以既有 500 失败，不在路由层吞掉。
    assert.deepEqual(parseMaaProfileBody([1, 2]), [1, 2]);
    assert.equal(parseMaaProfileBody('text'), 'text');
  });

  it('keeps the legacy dryRun truthiness for maintenance actions', () => {
    assert.deepEqual(parseDryRunBody(undefined), { dryRun: false });
    assert.deepEqual(parseDryRunBody({}), { dryRun: false });
    assert.deepEqual(parseDryRunBody({ dryRun: false }), { dryRun: false });
    assert.deepEqual(parseDryRunBody({ dryRun: true }), { dryRun: true });
    // 字符串 'false' 与非布尔真值在旧实现里同样按真值干跑。
    assert.deepEqual(parseDryRunBody({ dryRun: 'false' }), { dryRun: true });
    assert.deepEqual(parseDryRunBody({ dryRun: 1 }), { dryRun: true });
  });

  it('keeps the raw core update channel for equality checks and error details', () => {
    assert.deepEqual(parseUpdateCoreBody(undefined), { version: undefined, dryRun: false });
    assert.deepEqual(parseUpdateCoreBody({ version: 'beta', dryRun: true }), { version: 'beta', dryRun: true });
    assert.deepEqual(parseUpdateCoreBody({ version: 'stable' }), { version: 'stable', dryRun: false });
    // 未知渠道值保持原样：完成文案与错误详情沿用旧实现的透传。
    assert.deepEqual(parseUpdateCoreBody({ version: 5 }), { version: 5, dryRun: false });
  });

  it('defaults the schedule id only when it is omitted', () => {
    assert.deepEqual(parseScheduleSetupBody(undefined), { scheduleId: 'default', times: undefined, taskFlow: undefined });
    assert.deepEqual(parseScheduleSetupBody({ times: ['08:00'] }), { scheduleId: 'default', times: ['08:00'], taskFlow: undefined });
    assert.equal(parseScheduleSetupBody({ scheduleId: 'nightly' }).scheduleId, 'nightly');
    assert.equal(parseScheduleSetupBody({ scheduleId: '' }).scheduleId, '');
    // 非字符串按文本收窄：注册表键与停止路由的字符串参数保持同一形式。
    assert.equal(parseScheduleSetupBody({ scheduleId: 5 }).scheduleId, '5');
    const taskFlow = [{ id: 'fight' }];
    assert.equal(parseScheduleSetupBody({ taskFlow }).taskFlow, taskFlow);
  });

  it('passes the auto-update config through with extension fields intact', () => {
    const config = { enabled: true, time: '04:00', updateCore: false, extension: { keep: true } };
    assert.deepEqual(parseAutoUpdateBody(config), config);
    for (const body of [undefined, null, 'text', [1, 2]]) {
      assert.deepEqual(parseAutoUpdateBody(body), {});
    }
  });

  it('trims the paradox and copilot search parameters', () => {
    assert.deepEqual(parseParadoxSearchQuery({ name: '  干员A ' }), { name: '干员A' });
    assert.deepEqual(parseParadoxSearchQuery({}), { name: '' });
    assert.deepEqual(parseParadoxSearchQuery(undefined), { name: '' });
    assert.deepEqual(parseCopilotSearchQuery({ stage: ' 1-7 ' }), { stage: '1-7' });
    assert.deepEqual(parseCopilotSearchQuery({}), { stage: '' });
  });

  it('falls back to the normal raid for unknown plan modes', () => {
    assert.deepEqual(parseCopilotPlanQuery({ raid: 'raid' }), { raid: 'raid' });
    assert.deepEqual(parseCopilotPlanQuery({ raid: 'both' }), { raid: 'both' });
    for (const query of [undefined, {}, { raid: 'bogus' }, { raid: ['raid'] }, { raid: 1 }]) {
      assert.deepEqual(parseCopilotPlanQuery(query), { raid: 'normal' });
    }
  });

  it('keeps the changelog entry projection and rejects non-array payloads', () => {
    const releases = parseGithubReleaseList([
      { tag_name: 'v6.1.0-beta1', name: 'beta', body: 'b', published_at: 't1', html_url: 'u1', prerelease: true },
      'not-a-release',
      { tag_name: 'v6.0.0', name: 'stable', body: 's', published_at: 't2', html_url: 'u2', prerelease: false }
    ]);
    assert.deepEqual(releases.map(toChangelogEntry), [
      { version: 'v6.1.0-beta1', name: 'beta', body: 'b', publishedAt: 't1', htmlUrl: 'u1', prerelease: true },
      { version: 'v6.0.0', name: 'stable', body: 's', publishedAt: 't2', htmlUrl: 'u2', prerelease: false }
    ]);
    // 上游不是列表时按响应异常抛出，由路由映射既有 502（旧实现同样在 find 处抛错）。
    for (const payload of [undefined, null, {}, { message: 'rate limited' }]) {
      assert.throws(() => parseGithubReleaseList(payload), TypeError);
    }
  });

  it('narrows the PRTS query envelope and its non-array list', () => {
    assert.deepEqual(parsePrtsCopilotQueryPayload({ status_code: 200, data: { data: [] } }), {
      statusCode: 200,
      items: [],
      hasNext: false
    });
    assert.deepEqual(parsePrtsCopilotQueryPayload({ status_code: 500, data: { data: [{ id: 1 }, 'skip'], has_next: 1 } }), {
      statusCode: 500,
      items: [{ id: 1 }],
      hasNext: true
    });
    // 非数组列表落到未找到分支，与旧实现的 `.length` 判定一致。
    assert.deepEqual(parsePrtsCopilotQueryPayload({ status_code: 200, data: { data: { id: 1 } } }).items, []);
    for (const payload of [undefined, null, 'text', [1, 2]]) {
      assert.throws(() => parsePrtsCopilotQueryPayload(payload), TypeError);
    }
  });

  it('projects copilot entries without rewriting upstream fields', () => {
    assert.deepEqual(projectParadoxCopilot({
      id: 5,
      content: JSON.stringify({ doc: { title: 'A-1 挂机' } }),
      views: 3,
      hot_score: 9,
      uploader_id: 'u1'
    }), {
      id: 5,
      uri: 'prts://5',
      views: 3,
      hotScore: 9,
      uploader: 'u1',
      title: 'A-1 挂机'
    });
    // 非 JSON content 沿用默认标题，与旧实现的 try/catch 一致。
    assert.equal(projectParadoxCopilot({ id: 6, content: 'not-json' }).title, '无标题');

    const candidate = projectCopilotSearchItem({
      id: 7,
      content: JSON.stringify({ doc: { title: '1-7 挂机' }, stage_name: 'main_01-07' }),
      views: 1,
      hot_score: 2,
      uploader_id: 'u2'
    }, '1-7');
    assert.deepEqual(candidate, {
      entry: {
        id: 7,
        uri: 'prts://7',
        views: 1,
        hotScore: 2,
        uploader: 'u2',
        title: '1-7 挂机',
        stageName: 'main_01-07'
      },
      // 旧规则的标题代号只识别 2-4 个字母加数字，'1-7 挂机' 不产生代号。
      titleStageCode: ''
    });
    // 带关卡代号的标题参与匹配：'MAIN-07' 归一为大写代号。
    assert.equal(projectCopilotSearchItem({
      id: 9,
      content: JSON.stringify({ doc: { title: 'MAIN-07 挂机' } })
    }, 'MAIN-07').titleStageCode, 'MAIN-07');
    // content 缺失时改回请求关卡，且不会带出空标题代号。
    const fallback = projectCopilotSearchItem({ id: 8 }, '1-7');
    assert.equal(fallback.entry.title, '无标题');
    assert.equal(fallback.entry.stageName, '1-7');
    assert.equal(fallback.titleStageCode, '');
  });

  it('reports unreadable resource versions as unknown instead of current', () => {
    const fallback = resourceInfoFallback(new Error('boom'));
    assert.equal(fallback.status, 'unknown');
    assert.equal(fallback.message, '资源版本读取失败: boom');
    assert.equal(fallback.lastUpdated, null);
    assert.equal(fallback.activity, null);
  });
});

describe('moved maintenance routes keep HTTP contracts', () => {
  it('rejects every moved maintenance entry before any CLI or ADB side effect', async () => {
    const port = await listen(createLaPlumaApp({
      env: { LA_PLUMA_TOKEN: 'api-secret' },
      loginRateLimit: { maxAuthFailures: 100 }
    }));
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;
    const requests: ReadonlyArray<readonly [string, string]> = [
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
      assert.equal((await readError(response)).error.code, 'AGENT_AUTH_REQUIRED');
    }

    assert.equal(await callCliLog(), '');
    assert.equal(await callAdbLog(), '');
  });

  it('serves version, config directory and schedule status from the existing sources', async () => {
    const port = await listen(createLaPlumaApp({ env: {} }));
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;

    const version = await readSuccess<VersionPayload>(await fetch(`${baseUrl}/version`));
    assert.equal(version.data.cli, 'v0.7.0');
    assert.equal(version.data.core, 'v6.2.3');
    assert.equal(version.data.resource.status, 'current');

    const configDir = await readSuccess<ConfigDirectoryPayload>(await fetch(`${baseUrl}/config-directory`));
    assert.equal(configDir.data.path, maaConfigDir);

    const scheduleStatus = await readSuccess<unknown>(await fetch(`${baseUrl}/schedules/status`));
    assert.equal(typeof scheduleStatus.data, 'object');

    const execution = await readSuccess<ScheduleExecutionPayload>(await fetch(`${baseUrl}/schedules/execution`));
    assert.equal(execution.data.isRunning, false);

    const autoUpdate = await readSuccess<AutoUpdateStatusPayload>(await fetch(`${baseUrl}/auto-update/status`));
    assert.equal(autoUpdate.data.enabled, false);
    assert.equal(autoUpdate.data.time, null);
  });

  it('keeps connection test and device discovery on the existing ADB contract', async () => {
    const port = await listen(createLaPlumaApp({ env: {} }));
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;

    const testConnection = await postJson(`${baseUrl}/actions/test-connection`, {
      adbPath: fakeAdbPath,
      address: '127.0.0.1:5555'
    });
    assert.equal(testConnection.status, 200);
    const tested = await readSuccess<TestConnectionPayload>(testConnection);
    assert.equal(tested.data.connected, true);
    assert.match(await callAdbLog(), /^connect 127\.0\.0\.1:5555$/m);

    const discover = await fetch(`${baseUrl}/actions/discover-devices?adbPath=${encodeURIComponent(fakeAdbPath)}`);
    assert.equal(discover.status, 200);
    const discovered = await readSuccess<DiscoveryPayload>(discover);
    assert.ok(Array.isArray(discovered.data.devices));
  });

  it('returns dry-run plans without starting updates or recognition', async () => {
    const port = await listen(createLaPlumaApp({ env: {} }));
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;
    const cliBefore = await callCliLog();
    const adbBefore = await callAdbLog();

    const core = await postJson(`${baseUrl}/actions/update-core`, { dryRun: true, version: 'beta' });
    const coreBody = await readSuccess<UpdateCorePayload>(core);
    assert.equal(coreBody.data.plan.action, 'update-core-and-resources');
    assert.equal(coreBody.data.plan.steps[0].targetChannel, 'beta');
    assert.equal(coreBody.meta.dryRun, true);

    const cli = await postJson(`${baseUrl}/actions/update-cli`, { dryRun: true });
    const cliBody = await readSuccess<UpdateCliPayload>(cli);
    assert.equal(cliBody.data.plan.action, 'update-cli');

    const resources = await postJson(`${baseUrl}/actions/hot-update-resources`, { dryRun: true });
    const resourceBody = await readSuccess<DryRunPlanPayload>(resources);
    assert.equal(resourceBody.data.plan.action, 'hot-update-resources');

    for (const action of ['depot-recognition', 'operbox-recognition']) {
      const response = await postJson(`${baseUrl}/actions/${action}`, { dryRun: true });
      const body = await readSuccess<DryRunPlanPayload>(response);
      assert.equal(body.success, true, action);
      assert.equal(body.data.plan.action, action);
    }

    // dryRun 只返回计划：不能隐式触发 MAA 更新或识别动作的解析/缓存写入。
    assert.equal(await callCliLog(), cliBefore);
    assert.equal(await callAdbLog(), adbBefore);
  });

  it('treats any truthy dryRun value as plan-only without touching the CLI', async () => {
    const port = await listen(createLaPlumaApp({ env: {} }));
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;
    const cliBefore = await callCliLog();

    // 字符串 'false' 与数值在旧实现中是真值，仍按干跑处理。
    const core = await postJson(`${baseUrl}/actions/update-core`, { dryRun: 'false' });
    assert.equal(core.status, 200);
    const coreBody = await readSuccess<{ plan: MaintenanceUpdateCorePlan }>(core);
    assert.equal(coreBody.meta.dryRun, true);
    assert.equal(coreBody.data.plan.steps[0].targetChannel, 'current');

    const cli = await postJson(`${baseUrl}/actions/update-cli`, { dryRun: 1 });
    assert.equal(cli.status, 200);
    const cliBody = await readSuccess<{ plan: MaintenanceUpdateCliPlan }>(cli);
    assert.equal(cliBody.meta.dryRun, true);
    assert.equal(cliBody.data.plan.action, 'update-cli');

    assert.equal(await callCliLog(), cliBefore);
  });

  it('rejects invalid schedule registrations without registering a trigger', async () => {
    const port = await listen(createLaPlumaApp({ env: {} }));
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;
    const before = await readSuccess<unknown>(await fetch(`${baseUrl}/schedules/status`));

    const invalidFlow = await postJson(`${baseUrl}/schedules`, { times: ['08:00'], taskFlow: 'not-an-array' });
    assert.equal(invalidFlow.status, 400);
    const invalidFlowBody = await readError(invalidFlow);
    assert.equal(invalidFlowBody.error.code, 'AGENT_SCHEDULE_SETUP_FAILED');
    assert.equal(invalidFlowBody.message, '任务流程格式无效');

    const missingTimes = await postJson(`${baseUrl}/schedules`, { taskFlow: [] });
    assert.equal(missingTimes.status, 400);
    const missingTimesBody = await readError(missingTimes);
    assert.equal(missingTimesBody.error.code, 'AGENT_SCHEDULE_SETUP_FAILED');
    assert.equal(missingTimesBody.message, '没有设置执行时间');

    // 配置校验失败不能留下定时注册，也不能启动执行。
    const after = await readSuccess<unknown>(await fetch(`${baseUrl}/schedules/status`));
    assert.deepEqual(after.data, before.data);
    const execution = await readSuccess<{ isRunning: boolean }>(await fetch(`${baseUrl}/schedules/execution`));
    assert.equal(execution.data.isRunning, false);
  });

  it('keeps the auto-update registration gate without scheduling anything', async () => {
    const port = await listen(createLaPlumaApp({ env: {} }));
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;
    const before = await readSuccess<unknown>(await fetch(`${baseUrl}/auto-update/status`));

    const disabled = await postJson(`${baseUrl}/actions/configure-auto-update`, { enabled: false, time: '04:00' });
    assert.equal(disabled.status, 200);
    const disabledBody = await readSuccess<{ success: boolean; message: string }>(disabled);
    // 注册入口只回传调度域结果：HTTP 文案仍是通用的“操作成功”。
    assert.equal(disabledBody.message, '操作成功');
    assert.equal(disabledBody.data.success, false);
    assert.equal(disabledBody.data.message, '自动更新未启用');

    const missingTime = await postJson(`${baseUrl}/actions/configure-auto-update`, { enabled: true });
    const missingTimeBody = await readSuccess<{ success: boolean; message: string }>(missingTime);
    assert.equal(missingTimeBody.data.success, false);
    assert.equal(missingTimeBody.data.message, '自动更新未启用');

    const after = await readSuccess<unknown>(await fetch(`${baseUrl}/auto-update/status`));
    assert.deepEqual(after.data, before.data);
  });

  it('keeps profile read and write on the MAA config directory', async () => {
    const port = await listen(createLaPlumaApp({ env: {} }));
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;

    const saved = await postJson(`${baseUrl}/config/maa/default`, {
      connection: { adb_path: '/opt/adb', address: '127.0.0.1:6000' }
    });
    const savedBody = await readSuccess<null>(saved);
    assert.equal(savedBody.message, '配置保存成功');

    const read = await readSuccess<ProfilePayload>(await fetch(`${baseUrl}/config/maa/default`));
    assert.equal(read.data.adb_path, '/opt/adb');
    assert.equal(read.data.address, '127.0.0.1:6000');
    assert.match(await readFile(join(maaConfigDir, 'profiles', 'default.toml'), 'utf-8'), /127\.0\.0\.1:6000/);
  });

  it('keeps the profile name validation contract for save requests', async () => {
    const port = await listen(createLaPlumaApp({ env: {} }));
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;

    const response = await postJson(`${baseUrl}/config/maa/-invalid`, { connection: {} });
    assert.equal(response.status, 500);
    const body = await readError(response);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'AGENT_INTERNAL_ERROR');
    // 非法 profile 名在写入前被拒绝：错误响应走统一出口，不落盘。
    await assert.rejects(readFile(join(maaConfigDir, 'profiles', '-invalid.toml'), 'utf-8'), { code: 'ENOENT' });
  });

  it('rejects non-object profile bodies before writing any profile file', async () => {
    const port = await listen(createLaPlumaApp({ env: {} }));
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;

    const response = await postJson(`${baseUrl}/config/maa/nonobject`, [1, 2]);
    assert.equal(response.status, 500);
    const body = await readError(response);
    assert.equal(body.error.code, 'AGENT_INTERNAL_ERROR');
    // connection 合并规则仍由 maaConfigService 判定，失败时不产生半份 profile。
    await assert.rejects(readFile(join(maaConfigDir, 'profiles', 'nonobject.toml'), 'utf-8'), { code: 'ENOENT' });
  });

  it('rejects missing search parameters before any outbound request', async t => {
    const outbound = guardOutboundFetch(t);
    const port = await listen(createLaPlumaApp({ env: {} }));
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;

    const missingName = await fetch(`${baseUrl}/paradox/search`);
    assert.equal(missingName.status, 400);
    assert.equal((await readError(missingName)).error.code, 'AGENT_VALIDATION_OPERATOR_NAME_REQUIRED');

    const missingStage = await fetch(`${baseUrl}/copilot/search`);
    assert.equal(missingStage.status, 400);
    assert.equal((await readError(missingStage)).error.code, 'AGENT_VALIDATION_STAGE_REQUIRED');

    assert.deepEqual(outbound.external, []);
  });

  it('maps a non-array changelog payload to the preserved upstream error', async t => {
    const realFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href);
      if (url.hostname === '127.0.0.1') return realFetch(input, init);
      // 上游 200 但不是 releases 列表：旧实现在 find 处抛错，仍映射同一 502。
      return jsonResponse({ message: 'unexpected payload' });
    });
    const port = await listen(createLaPlumaApp({ env: {} }));
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;

    const response = await fetch(`${baseUrl}/changelog/core`);
    assert.equal(response.status, 502);
    const body = await readError(response);
    assert.equal(body.error.code, 'AGENT_CHANGELOG_CORE_FETCH_FAILED');
    assert.equal(body.error.retryable, true);
    assert.deepEqual(body.error.details, { provider: 'github', target: 'MaaAssistantArknights' });
  });

  it('resolves the copilot set plan through the existing plan service', async t => {
    const realFetch = globalThis.fetch;
    const outboundCalls: string[] = [];
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href);
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

    const port = await listen(createLaPlumaApp({ env: {} }));
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;

    // raid 只识别 normal/raid/both：未知值沿用旧实现回落 normal，不改变计划入口。
    const response = await fetch(`${baseUrl}/copilot-sets/42/plan?raid=bogus`);
    assert.equal(response.status, 200);
    const body = await readSuccess<CopilotPlanPayload>(response);
    assert.equal(body.data.setId, '42');
    assert.equal(body.data.name, 'fixture set');
    assert.equal(body.data.entries.length, 1);
    assert.equal(body.data.entries[0].copilotId, 100);
    assert.deepEqual(outboundCalls.map(url => new URL(url).pathname), ['/set/get', '/copilot/get/100']);
  });
});
