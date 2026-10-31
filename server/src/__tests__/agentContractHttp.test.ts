import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import type { WebrtcSignalingGateway } from '../services/webrtcSignalingGateway.ts';
import type {
  JsonSchema,
  OpenApiOperation,
  RegisteredAgentOperation
} from '../routes/agentContract.ts';

/**
 * 公开契约与真实 HTTP 的一致性回归。
 *
 * 能力清单、manifest 与 OpenAPI 由 `routes/agentContract.ts` 的同一份
 * `AGENT_OPERATIONS` 生成；本文件只通过 `createLaPlumaApp` 发起真实 HTTP，
 * 用发布出来的 JSON Schema 校验请求与响应 fixture，不再抄写第二份字段表。
 *
 * 校验器为 ajv 8.20.0 的 `ajv/dist/2020` 入口（JSON Schema draft 2020-12，
 * 与 OpenAPI 3.1 的 `$schema` 一致）；`ajv-formats` 3.0.1 只补公开文档实际
 * 使用的 `uuid`/`date-time`/`uri-reference` 格式。校验输入是生成器输出的
 * `components`，`$ref` 直接指向同一份文档。
 *
 * 设备动作全部使用临时目录、假 MAA CLI 与假 ADB，不连接真实设备；WebRTC
 * 组件目录为空，因此启停只验证本实例所有权与错误出口，不启动外部进程。
 * 活动缓存由夹具写入，预检与作业发现不会访问上游数据源。
 */

const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-contract-http-'));
const maaLogDir = join(fixtureDir, 'maa-logs');
const maaCacheDir = join(fixtureDir, 'maa-cache');
const xdgDataHome = join(fixtureDir, 'xdg-data');
const xdgStateHome = join(fixtureDir, 'xdg-state');
const xdgConfigHome = join(fixtureDir, 'xdg-config');
const resourceDir = join(xdgDataHome, 'maa', 'resource');
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');
const fakeAdbPath = join(fixtureDir, 'fake-adb.js');
const cliCallLog = join(fixtureDir, 'maa-calls.log');
const adbCallLog = join(fixtureDir, 'adb-calls.log');
const userConfigDir = join(fixtureDir, 'user-configs');
const deviceAddress = '127.0.0.1:7555';
const missingRunId = '00000000-0000-4000-8000-000000000000';

// 1x1 PNG：截图用例只依赖 PNG 签名与 IHDR 宽高，不需要真实屏幕内容。
const pngBytes = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000a49444154789c6300010000050001',
  'hex'
);

await mkdir(maaLogDir, { recursive: true });
await mkdir(maaCacheDir, { recursive: true });
await mkdir(resourceDir, { recursive: true });
await mkdir(join(resourceDir, 'tasks', 'Stages'), { recursive: true });
await mkdir(join(xdgConfigHome, 'maa'), { recursive: true });

// 活动导航资源取本地 MAA 资源文件：预检进入 ready 后，缓存活动没有关卡列表，
// 作业发现会在查询上游之前判定 blocked，用例因此不访问 PRTS 或资源更新脚本。
await writeFile(join(resourceDir, 'tasks', 'Stages', 'TEST.json'), JSON.stringify({
  'TEST-OpenOpt': { next: ['TEST-OpenOcr'] },
  'TEST-OpenOcr': { next: ['TEST-Stage'] },
  'TEST-1': { sub: ['TEST-OpenOpt'], next: ['TEST-Stage'] }
}));

await writeFile(fakeCliPath, `#!${process.execPath}
const fs = require('node:fs');
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
// 只记录会改动设备的命令；目录/版本/活动查询不进入副作用断言。
fs.appendFileSync(process.env.FAKE_CONTRACT_CLI_LOG, args.join(' ') + '\\n');
process.exit(0);
`, { mode: 0o755 });

await writeFile(fakeAdbPath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CONTRACT_ADB_LOG, args.join(' ') + '\\n');
if (args[0] === 'version') {
  process.stdout.write('Android Debug Bridge version 1.0.41\\n');
} else if (args[0] === 'devices') {
  process.stdout.write('List of devices attached\\n${deviceAddress}\\tdevice\\n');
} else if (args[0] === 'connect') {
  process.stdout.write('connected\\n');
} else if (args[0] === '-s') {
  const shellIndex = args.indexOf('shell');
  const command = shellIndex >= 0 ? args.slice(shellIndex + 1).join(' ') : '';
  if (args.includes('exec-out')) {
    process.stdout.write(Buffer.from('${pngBytes.toString('base64')}', 'base64'));
  } else if (command.startsWith('dumpsys window')) {
    process.stdout.write('mCurrentFocus=Window{1a2b3c com.example/.MainActivity}\\n');
  } else if (command.startsWith('dumpsys display')) {
    process.stdout.write('real 1080 x 1920\\nmCurrentOrientation=0\\n');
  } else if (command.startsWith('settings get')) {
    process.stdout.write('0\\n');
  } else {
    process.stdout.write('');
  }
}
`, { mode: 0o755 });

process.env.MAA_CLI_PATH = fakeCliPath;
process.env.ADB_PATH = fakeAdbPath;
process.env.FAKE_CONTRACT_CLI_LOG = cliCallLog;
process.env.FAKE_CONTRACT_ADB_LOG = adbCallLog;
process.env.MAA_CACHE_DIR = maaCacheDir;
process.env.XDG_DATA_HOME = xdgDataHome;
process.env.XDG_STATE_HOME = xdgStateHome;
process.env.XDG_CONFIG_HOME = xdgConfigHome;
process.env.LA_PLUMA_AGENT_RUN_STORE = join(fixtureDir, 'agent-runs.json');
process.env.LA_PLUMA_MAA_LOCK_FILE = join(fixtureDir, 'maa-execution.lock');
process.env.LA_PLUMA_DROP_RECORDS_DIR = join(fixtureDir, 'drop-records');
process.env.LA_PLUMA_COPILOT_PROGRESS_STORE = join(fixtureDir, 'copilot-progress.json');
process.env.LA_PLUMA_WEBRTC_DIR = join(fixtureDir, 'webrtc');
process.env.LA_PLUMA_WEBRTC_ICE_SERVERS = '';

const { WEBRTC_SIGNALING_PATH } = await import('../services/webrtcSignalingGateway.ts');
const { setConfigStorageDirForTests, saveUserConfig } = await import('../services/configStorageService.ts');
const { loggerManager } = await import('../utils/logger.ts');
const { createLaPlumaApp } = await import('../app.ts');
const { default: agentRouter } = await import('../routes/agent.ts');
const {
  AGENT_OPERATIONS,
  buildAgentManifest,
  buildOpenApiSpec
} = await import('../routes/agentContract.ts');
const { DEFAULT_ADB_ADDRESS, DEFAULT_ADB_PATH, DEFAULT_CLIENT_TYPE } = await import('../config/connectionDefaults.ts');

// 真实 HTTP 用例会产生服务日志；关闭控制台输出，保持门禁输出可读。
for (const loggerName of ['Api', 'MaaService', 'AgentRoutes', 'AgentRunService', 'Scheduler', 'DropRecord', 'DataParser']) {
  loggerManager.getLogger(loggerName).enableConsole = false;
}

// 活动缓存写进临时用户配置目录：预检与作业发现读取缓存后直接判定导航资源
// 缺失，不访问 maa activity 之外的外部数据源，也不改写仓库内的运行数据。
setConfigStorageDirForTests(userConfigDir);
const seededAt = Date.now();
await saveUserConfig('activity-cache', {
  [DEFAULT_CLIENT_TYPE]: {
    code: 'TEST',
    name: 'Contract Fixture',
    source: 'fixture',
    startTime: null,
    endTime: null,
    stages: [],
    timestamp: seededAt,
    ttl: 24 * 60 * 60 * 1000
  }
});

const serverDefaults = {
  adbPath: DEFAULT_ADB_PATH,
  adbAddress: DEFAULT_ADB_ADDRESS,
  clientType: DEFAULT_CLIENT_TYPE
};

const openApiSpec = buildOpenApiSpec(serverDefaults);
const manifest = buildAgentManifest(serverDefaults);
const operationsById = new Map<string, RegisteredAgentOperation>(AGENT_OPERATIONS.map(item => [item.id, item]));
const openApiOperationsById = new Map<string, OpenApiOperation>(
  AGENT_OPERATIONS.map(item => [item.id, openApiSpec.paths[item.path][item.method.toLowerCase()]])
);

const documentId = 'la-pluma-agent-contract';
const ajv = new Ajv2020({ strict: false, allErrors: true });
// 插件同时经 module.exports 与 exports.default 暴露；取声明的 default 导出即可调用。
addFormatsModule.default(ajv);
ajv.addSchema({ $id: documentId, components: openApiSpec.components }, documentId);
const compiledSchemas = new Map<string, ValidateFunction>();

function compileSchema(schema: JsonSchema): ValidateFunction {
  const key = schema.$ref ?? JSON.stringify(schema);
  const cached = compiledSchemas.get(key);
  if (cached) return cached;
  const target = schema.$ref
    ? { $ref: `${documentId}#${schema.$ref.slice(1)}` }
    : schema;
  const validate = ajv.compile(target);
  compiledSchemas.set(key, validate);
  return validate;
}

function schemaErrors(schema: JsonSchema, value: unknown): string {
  const validate = compileSchema(schema);
  return validate(value) ? '' : ajv.errorsText(validate.errors, { separator: '; ' });
}

function assertMatchesSchema(schema: JsonSchema, value: unknown, label: string): void {
  const errors = schemaErrors(schema, value);
  assert.equal(errors, '', `${label} must match the published schema: ${errors}`);
}

function assertViolatesSchema(schema: JsonSchema, value: unknown, label: string): void {
  const errors = schemaErrors(schema, value);
  assert.notEqual(errors, '', `${label} must be rejected by the published schema`);
}

/** Express router 与 route layer 是带属性的函数/对象；两者都按对象读取。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && !Array.isArray(value);
}

function resolvePointer(document: unknown, pointer: string): unknown {
  return pointer
    .split('/')
    .slice(1)
    .reduce<unknown>((current, segment) => {
      if (!isRecord(current)) return undefined;
      return current[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
    }, document);
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return isRecord(value);
}

/** 读取 OpenAPI 操作在某个状态码声明的 JSON Schema。 */
function responseSchema(operation: OpenApiOperation, status: number): JsonSchema {
  const response = operation.responses[String(status)];
  assert.ok(response, `${operation.operationId} must declare status ${status}`);
  if (response.$ref) {
    const resolved = resolvePointer(openApiSpec, response.$ref);
    assert.ok(isRecord(resolved), `${operation.operationId} response ref ${response.$ref} must resolve`);
    const schema = isRecord(resolved.content)
      && isRecord(resolved.content['application/json'])
      ? resolved.content['application/json'].schema
      : undefined;
    assert.ok(isJsonSchema(schema), `${operation.operationId} ${status} must publish a JSON schema`);
    return schema;
  }
  const schema = isRecord(response.content) && isRecord(response.content['application/json'])
    ? response.content['application/json'].schema
    : undefined;
  assert.ok(isJsonSchema(schema), `${operation.operationId} ${status} must publish a JSON schema`);
  return schema;
}

interface MountedRoute {
  path: string;
  methods?: Record<string, boolean>;
  stack: unknown[];
}

function isMountedRoute(value: unknown): value is MountedRoute {
  if (!isRecord(value)) return false;
  if (typeof value.path !== 'string') return false;
  if (value.methods !== undefined && !isRecord(value.methods)) return false;
  return Array.isArray(value.stack);
}

/** 遍历实际挂载的 router 图，统计 `METHOD path` 出现次数。 */
function collectMountedRoutes(router: unknown, counts = new Map<string, number>()): Map<string, number> {
  if (!isRecord(router) || !Array.isArray(router.stack)) return counts;
  for (const layer of router.stack) {
    if (!isRecord(layer)) continue;
    if (isMountedRoute(layer.route)) {
      for (const [method, enabled] of Object.entries(layer.route.methods ?? {})) {
        if (!enabled || method === '_all') continue;
        const key = `${method.toUpperCase()} ${layer.route.path}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      continue;
    }
    collectMountedRoutes(layer.handle, counts);
  }
  return counts;
}

const mountedRoutes = collectMountedRoutes(agentRouter);

function relativeAgentPath(path: string): string {
  return path
    .replace(/^\/api\/agent/, '')
    .replace(/\{([^}]+)\}/g, ':$1');
}

interface FixtureQuery {
  [name: string]: string | number;
}

interface RequestFixture {
  operationId: string;
  query?: FixtureQuery;
  body?: unknown;
  pathParams?: Record<string, string>;
  status: number;
  expectRun?: boolean;
}

interface ValidFixture extends RequestFixture {
  /** 供失败信息定位；与 operationId 一起构成每条公开能力的 HTTP 对照。 */
  note?: string;
}

const validFixtures: readonly ValidFixture[] = [
  { operationId: 'get_manifest', status: 200 },
  { operationId: 'get_openapi', status: 200 },
  { operationId: 'get_status', status: 200, query: { adbPath: fakeAdbPath, address: deviceAddress } },
  { operationId: 'test_connection', status: 200, body: { adbPath: fakeAdbPath, address: deviceAddress } },
  { operationId: 'discover_devices', status: 200, query: { adbPath: fakeAdbPath } },
  { operationId: 'activity_run_preflight', status: 200, query: { clientType: DEFAULT_CLIENT_TYPE } },
  { operationId: 'activity_copilot_candidates', status: 200, query: { clientType: DEFAULT_CLIENT_TYPE } },
  {
    operationId: 'run_current_activity_copilots',
    status: 200,
    body: { clientType: DEFAULT_CLIENT_TYPE },
    expectRun: true
  },
  {
    operationId: 'start_game',
    status: 200,
    body: { clientType: DEFAULT_CLIENT_TYPE, address: deviceAddress },
    expectRun: true
  },
  { operationId: 'fight', status: 200, body: { stages: ['1-7'], dryRun: true } },
  { operationId: 'run_task', status: 200, body: { command: 'award' }, expectRun: true },
  { operationId: 'stop_task', status: 200, body: {} },
  { operationId: 'get_current_run', status: 200, query: { lines: 2 } },
  { operationId: 'get_run', status: 404, pathParams: { runId: missingRunId } },
  { operationId: 'get_screenshot', status: 200, body: { adbPath: fakeAdbPath, address: deviceAddress } },
  {
    operationId: 'run_daily_flow',
    status: 200,
    body: {
      dryRun: true,
      taskFlow: [{ id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true }]
    }
  },
  { operationId: 'recent_logs', status: 200, query: { lines: 2 } },
  { operationId: 'webrtc_status', status: 200, query: { adbPath: fakeAdbPath, address: deviceAddress } },
  { operationId: 'webrtc_devices', status: 200 },
  // WebRTC 组件目录为空：启动在安装检查处失败，走既有 500 错误出口。
  { operationId: 'webrtc_start', status: 500, body: { adbPath: fakeAdbPath, address: deviceAddress } },
  { operationId: 'webrtc_stop', status: 200, body: { adbPath: fakeAdbPath, address: deviceAddress } },
  { operationId: 'preview_orientation', status: 200, body: { orientation: 'portrait', dryRun: true } },
  { operationId: 'get_current_activity', status: 200, query: { clientType: DEFAULT_CLIENT_TYPE } }
];

interface ErrorFixture extends RequestFixture {
  errorCode: string;
}

const invalidFixtures: readonly ErrorFixture[] = [
  { operationId: 'get_status', status: 400, query: { profileId: 'bad id!' }, errorCode: 'AGENT_VALIDATION_PROFILE_ID_INVALID' },
  { operationId: 'test_connection', status: 400, body: { profileId: 'bad id!' }, errorCode: 'AGENT_VALIDATION_PROFILE_ID_INVALID' },
  { operationId: 'discover_devices', status: 400, query: { profileId: 'bad id!' }, errorCode: 'AGENT_VALIDATION_PROFILE_ID_INVALID' },
  { operationId: 'activity_run_preflight', status: 400, query: { profileId: 'bad id!' }, errorCode: 'AGENT_VALIDATION_PROFILE_ID_INVALID' },
  { operationId: 'activity_copilot_candidates', status: 400, query: { profileId: 'bad id!' }, errorCode: 'AGENT_VALIDATION_PROFILE_ID_INVALID' },
  { operationId: 'run_current_activity_copilots', status: 400, body: { profileId: 'bad id!' }, errorCode: 'AGENT_VALIDATION_PROFILE_ID_INVALID' },
  { operationId: 'start_game', status: 400, body: { waitForCompletion: 'later' }, errorCode: 'AGENT_VALIDATION_WAIT_FOR_COMPLETION_INVALID' },
  { operationId: 'fight', status: 400, body: {}, errorCode: 'AGENT_VALIDATION_MISSING_STAGES' },
  { operationId: 'run_task', status: 400, body: { command: 'not-a-command' }, errorCode: 'AGENT_VALIDATION_COMMAND_NOT_ALLOWED' },
  { operationId: 'stop_task', status: 400, body: { runId: 42 }, errorCode: 'AGENT_VALIDATION_RUN_ID_INVALID' },
  { operationId: 'get_screenshot', status: 400, body: { profileId: 'bad id!' }, errorCode: 'AGENT_VALIDATION_PROFILE_ID_INVALID' },
  { operationId: 'run_daily_flow', status: 400, body: { dryRun: 'false' }, errorCode: 'AGENT_VALIDATION_DRY_RUN_INVALID' },
  { operationId: 'webrtc_status', status: 400, query: { profileId: 'bad id!' }, errorCode: 'AGENT_VALIDATION_PROFILE_ID_INVALID' },
  { operationId: 'webrtc_start', status: 400, body: { profileId: 'bad id!' }, errorCode: 'AGENT_VALIDATION_PROFILE_ID_INVALID' },
  { operationId: 'webrtc_stop', status: 400, body: { profileId: 'bad id!' }, errorCode: 'AGENT_VALIDATION_PROFILE_ID_INVALID' },
  { operationId: 'preview_orientation', status: 400, body: { orientation: 'sideways' }, errorCode: 'AGENT_VALIDATION_ORIENTATION_INVALID' },
  { operationId: 'get_current_activity', status: 400, query: { profileId: 'bad id!' }, errorCode: 'AGENT_VALIDATION_PROFILE_ID_INVALID' }
];

/**
 * 运行时解析与静态 schema 的已知差异。用例同时断言两侧：请求确实不满足
 * 发布 schema，但既有运行时仍按兼容语义接受。任何一侧变化都会让用例失败，
 * 从而迫使实现与公开契约同步决定。
 */
interface DivergenceFixture extends RequestFixture {
  errorCode?: string;
  reason: string;
}

const divergenceFixtures: readonly DivergenceFixture[] = [
  {
    operationId: 'fight',
    status: 200,
    // 旧调用方仍可传单关卡字段；schema 只公布 stages 数组。
    body: { stage: '1-7', dryRun: true },
    reason: 'legacy single-stage fields stay accepted without being advertised'
  },
  {
    operationId: 'stop_task',
    status: 404,
    // schema 声明 format: uuid，运行时只要求非空字符串并按未知 run 返回 404。
    body: { runId: 'not-a-uuid' },
    errorCode: 'AGENT_RUN_NOT_FOUND',
    reason: 'runtime accepts any non-empty run id although the schema declares uuid'
  },
  {
    operationId: 'recent_logs',
    status: 200,
    // schema 声明 maximum 500；运行时把超界值夹取到上限而不是拒绝。
    query: { lines: 9999 },
    reason: 'out-of-range line counts are clamped instead of rejected'
  }
];

function buildRequest(baseUrl: string, operation: RegisteredAgentOperation, fixture: RequestFixture): {
  url: string;
  init: RequestInit;
} {
  let path = operation.path;
  for (const [name, value] of Object.entries(fixture.pathParams ?? {})) {
    path = path.replace(`{${name}}`, encodeURIComponent(value));
  }
  const url = new URL(path, baseUrl);
  for (const [name, value] of Object.entries(fixture.query ?? {})) {
    url.searchParams.set(name, String(value));
  }
  const init: RequestInit = { method: operation.method };
  if (fixture.body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(fixture.body);
  }
  return { url: url.toString(), init };
}

function assertRequestShape(operation: RegisteredAgentOperation, fixture: RequestFixture): void {
  if (fixture.body !== undefined) {
    assert.ok(operation.body_schema, `${operation.id} declares no body schema`);
    assertMatchesSchema(operation.body_schema, fixture.body, `${operation.id} request body`);
  }
  if (fixture.query) {
    assert.ok(operation.query_schema, `${operation.id} declares no query schema`);
    assertMatchesSchema(operation.query_schema, fixture.query, `${operation.id} request query`);
  }
  if (fixture.pathParams) {
    assert.ok(operation.path_schema, `${operation.id} declares no path schema`);
    assertMatchesSchema(operation.path_schema, fixture.pathParams, `${operation.id} request path`);
  }
}

const servers: Server[] = [];
let baseUrl = '';

function stubSignalingGateway(): WebrtcSignalingGateway {
  return {
    proxyPath: WEBRTC_SIGNALING_PATH,
    async handleLogin(_request, response) {
      response.json({ token: 'stub' });
    },
    async handleUpgrade() {},
    attach() {},
    close() {}
  };
}

async function listen(): Promise<void> {
  const app = createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function cliDeviceCalls(): Promise<string[]> {
  const content = await readFile(cliCallLog, 'utf-8').catch(() => '');
  return content.split('\n').filter(Boolean);
}

before(async () => {
  await listen();
});

after(async () => {
  while (servers.length) {
    const server = servers.pop();
    assert.ok(server);
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  setConfigStorageDirForTests(null);
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('Agent API contract registry and mounted routes', () => {
  it('covers every registered operation with a request fixture', () => {
    assert.deepEqual(
      validFixtures.map(fixture => fixture.operationId).sort(),
      AGENT_OPERATIONS.map(operation => operation.id).sort(),
      'each registry entry needs an HTTP fixture so new operations cannot skip contract coverage'
    );
  });

  it('registers every manifest and OpenAPI operation exactly once on the mounted router', () => {
    for (const operation of AGENT_OPERATIONS) {
      const key = `${operation.method} ${relativeAgentPath(operation.path)}`;
      assert.equal(
        mountedRoutes.get(key),
        1,
        `${operation.id} must be mounted exactly once as ${key}`
      );
    }
  });

  it('detects duplicate mounts instead of collapsing them into one entry', () => {
    const duplicates = [...mountedRoutes.entries()].filter(([, count]) => count > 1);
    assert.deepEqual(duplicates, [], 'the Agent router must not declare the same method/path twice');
  });

  it('keeps Web UI-only routes mounted without forcing them into the advertised manifest', () => {
    const advertisedPaths = new Set(manifest.actions.map(action => `${action.method} ${relativeAgentPath(action.path)}`));
    const webUiOnlyRoutes = [
      'POST /webrtc/install',
      'GET /logs/files',
      'POST /logs/cleanup',
      'GET /training/operators',
      'POST /copilot-sets/:id/execute',
      'GET /device-stats',
      // 以下入口的 HTTP 行为测试会触发宿主副作用或上游读取，只在这里守住挂载。
      'POST /actions/open-config-directory',
      'GET /paradox/operators',
      'POST /copilot-sets/:id/reset-progress'
    ];

    for (const key of webUiOnlyRoutes) {
      assert.equal(mountedRoutes.get(key), 1, `${key} must stay mounted for the Web UI`);
      assert.ok(!advertisedPaths.has(key), `${key} is Web UI-only and must not be advertised`);
    }
    assert.deepEqual(
      manifest.actions.map(action => action.id),
      AGENT_OPERATIONS.filter(operation => operation.advertised).map(operation => operation.id)
    );
    for (const action of manifest.actions) {
      const operation = operationsById.get(action.id);
      assert.ok(operation);
      assert.equal(action.method, operation.method);
      assert.equal(action.path, operation.path);
      assert.equal(openApiOperationsById.get(action.id)?.operationId, action.id);
    }
  });

  it('serves the manifest and OpenAPI document generated from the same registry', async () => {
    const manifestResponse = await fetch(`${baseUrl}/api/agent/manifest`);
    assert.equal(manifestResponse.status, 200);
    const manifestBody: unknown = await manifestResponse.json();
    assert.ok(isRecord(manifestBody));
    assert.deepEqual(manifestBody.data, manifest);

    const openApiResponse = await fetch(`${baseUrl}/api/agent/openapi.json`);
    assert.equal(openApiResponse.status, 200);
    const openApiBody: unknown = await openApiResponse.json();
    assert.deepEqual(openApiBody, openApiSpec);
    const documentSchema = openApiSpec.components.schemas.OpenApiDocument;
    assert.ok(documentSchema);
    assertMatchesSchema(documentSchema, openApiBody, 'served OpenAPI document');
    // 发布文档中的每个 $ref 都必须在同一份文档内可解析。
    for (const operation of AGENT_OPERATIONS) {
      const generated = openApiOperationsById.get(operation.id);
      assert.ok(generated);
      assert.equal(generated.operationId, operation.id);
      const success = generated.responses['200']?.content?.['application/json']?.schema;
      assert.ok(success);
      compileSchema(success);
    }
  });

  it('serves the seeded activity as an explicit status snapshot', async () => {
    const response = await fetch(`${baseUrl}/api/agent/activity?clientType=${DEFAULT_CLIENT_TYPE}`);
    assert.equal(response.status, 200);
    const payload: unknown = await response.json();
    assert.ok(isRecord(payload));
    assert.equal(payload.success, true);
    const data = payload.data;
    assert.ok(isRecord(data));
    assert.equal(data.status, 'active');
    assert.equal(data.clientType, DEFAULT_CLIENT_TYPE);
    assert.equal(data.available, true);
    assert.equal(data.code, 'TEST');
    assert.equal(data.name, 'Contract Fixture');
    assert.equal(data.source, 'fixture');
    assert.equal(data.startTime, null);
    assert.equal(data.endTime, null);
    assert.deepEqual(data.stages, []);
    assert.equal(data.lastSuccessAt, seededAt);
    assert.equal(data.dataUpdatedAt, null);
    assert.equal(data.failure, null);
    assert.equal(data.message, '当前活动: Contract Fixture');
    assert.ok(isRecord(data.completion));
    assert.equal(data.completion.known, false);
  });

  it('reports an unavailable activity without mapping an unsupported client to CN', async () => {
    const response = await fetch(`${baseUrl}/api/agent/activity?clientType=Txwy`);
    assert.equal(response.status, 200);
    const payload: unknown = await response.json();
    assert.ok(isRecord(payload));
    assert.equal(payload.success, true);
    const data = payload.data;
    assert.ok(isRecord(data));
    assert.equal(data.status, 'unavailable');
    assert.equal(data.clientType, 'Txwy');
    assert.equal(data.available, false);
    assert.equal(data.code, null);
    assert.equal(data.name, null);
    assert.equal(data.lastSuccessAt, null);
    assert.ok(isRecord(data.failure));
    assert.equal(data.failure.source, 'maa');
    assert.match(String(data.failure.message), /备用活动数据源不支持 Txwy/);
    assert.match(String(data.message), /^无法获取活动信息: /);
  });
});

describe('advertised operations over real HTTP', () => {
  for (const fixture of validFixtures) {
    it(`matches the declared request/response contract for ${fixture.operationId}`, async () => {
      const operation = operationsById.get(fixture.operationId);
      assert.ok(operation, `unknown operation ${fixture.operationId}`);
      const generated = openApiOperationsById.get(fixture.operationId);
      assert.ok(generated);
      assertRequestShape(operation, fixture);

      const request = buildRequest(baseUrl, operation, fixture);
      const response = await fetch(request.url, request.init);
      const payload: unknown = await response.json();

      assert.equal(
        response.status,
        fixture.status,
        `${operation.method} ${operation.path} returned ${response.status}: ${JSON.stringify(payload)}`
      );
      assertMatchesSchema(
        responseSchema(generated, response.status),
        payload,
        `${fixture.operationId} ${response.status} response`
      );

      if (fixture.expectRun) {
        assert.equal(response.status, 200);
        assert.match(response.headers.get('x-la-pluma-run-id') ?? '', /^[0-9a-f-]{36}$/i);
        assert.ok(['true', 'false'].includes(response.headers.get('idempotency-replayed') ?? ''));
      }
    });
  }

  it('rejects schema-invalid requests with the declared error envelope before device side effects', async () => {
    const callsBefore = (await cliDeviceCalls()).length;

    for (const fixture of invalidFixtures) {
      const operation = operationsById.get(fixture.operationId);
      assert.ok(operation);
      if (fixture.body !== undefined) {
        assert.ok(operation.body_schema);
        assertViolatesSchema(operation.body_schema, fixture.body, `${fixture.operationId} invalid body`);
      }
      if (fixture.query) {
        assert.ok(operation.query_schema);
        assertViolatesSchema(operation.query_schema, fixture.query, `${fixture.operationId} invalid query`);
      }

      const request = buildRequest(baseUrl, operation, fixture);
      const response = await fetch(request.url, request.init);
      const payload: unknown = await response.json();

      assert.equal(response.status, fixture.status, `${fixture.operationId} invalid request status`);
      assertMatchesSchema(
        responseSchema(openApiOperationsById.get(fixture.operationId)!, response.status),
        payload,
        `${fixture.operationId} ${response.status} error response`
      );
      assert.ok(isRecord(payload) && isRecord(payload.error));
      assert.equal(payload.error.code, fixture.errorCode, `${fixture.operationId} error code`);
    }

    assert.equal((await cliDeviceCalls()).length, callsBefore, 'invalid requests must not reach the MAA CLI');
  });

  it('captures the runtime parsing that is looser than the published request schema', async () => {
    for (const fixture of divergenceFixtures) {
      const operation = operationsById.get(fixture.operationId);
      assert.ok(operation);
      const generated = openApiOperationsById.get(fixture.operationId);
      assert.ok(generated);
      if (fixture.body !== undefined) {
        assert.ok(operation.body_schema);
        assertViolatesSchema(operation.body_schema, fixture.body, `${fixture.operationId}: ${fixture.reason}`);
      }
      if (fixture.query) {
        assert.ok(operation.query_schema);
        assertViolatesSchema(operation.query_schema, fixture.query, `${fixture.operationId}: ${fixture.reason}`);
      }

      const request = buildRequest(baseUrl, operation, fixture);
      const response = await fetch(request.url, request.init);
      const payload: unknown = await response.json();

      assert.equal(response.status, fixture.status, `${fixture.operationId}: ${fixture.reason}`);
      assertMatchesSchema(
        responseSchema(generated, response.status),
        payload,
        `${fixture.operationId} ${response.status} response`
      );
      if (fixture.errorCode) {
        assert.ok(isRecord(payload) && isRecord(payload.error));
        assert.equal(payload.error.code, fixture.errorCode);
      }
    }
  });

  it('returns a retained run that matches the published Run DTO', async () => {
    const runTask = operationsById.get('run_task');
    assert.ok(runTask);
    const created = await fetch(`${baseUrl}/api/agent/actions/run-task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'award' })
    });
    assert.equal(created.status, 200);
    const createdBody: unknown = await created.json();
    assert.ok(isRecord(createdBody) && isRecord(createdBody.data));
    const runId = createdBody.data.runId;
    assert.ok(typeof runId === 'string', 'run_task must return a run id');

    const lookup = await fetch(`${baseUrl}/api/agent/runs/${encodeURIComponent(runId)}`);
    assert.equal(lookup.status, 200);
    const lookupBody: unknown = await lookup.json();
    const generated = openApiOperationsById.get('get_run');
    assert.ok(generated);
    assertMatchesSchema(responseSchema(generated, 200), lookupBody, 'retained run response');

    // 同一 Run 也必须满足快照里声明的 Run 结构，避免两处 DTO 漂移。
    const snapshot = await fetch(`${baseUrl}/api/agent/runs/current`);
    assert.equal(snapshot.status, 200);
    const snapshotBody: unknown = await snapshot.json();
    const currentRunOperation = openApiOperationsById.get('get_current_run');
    assert.ok(currentRunOperation);
    assertMatchesSchema(responseSchema(currentRunOperation, 200), snapshotBody, 'run snapshot response');
  });
});
