import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import type { ApiErrorResponse, ApiSuccessResponse } from '../utils/apiHelper.ts';
import type { WebrtcSignalingGateway } from '../services/webrtcSignalingGateway.ts';

// 执行入口已从 agent.js 拆到独立 router 并类型化：这里通过 createLaPlumaApp
// 验证真实 HTTP 的鉴权、body/query 收窄、统一错误出口、dryRun、幂等与目标
// 停止。外部依赖只有临时目录与假 MAA CLI，不连接真实设备或 MAA 运行时。
//
// 请求体与查询参数是 unknown 边界：非法输入必须在创建 Run、取得设备租约或
// 启动子进程之前被既有校验拒绝，本文件同时断言 CLI 调用日志为空。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-execution-http-'));
const maaLogDir = join(fixtureDir, 'maa-logs');
const xdgDataHome = join(fixtureDir, 'xdg-data');
const xdgStateHome = join(fixtureDir, 'xdg-state');
const xdgConfigHome = join(fixtureDir, 'xdg-config');
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');
const maaCacheDir = join(fixtureDir, 'maa-cache');
const fakeAdbPath = join(fixtureDir, 'fake-adb.js');
const cliCallLog = join(fixtureDir, 'maa-calls.log');

await mkdir(maaLogDir, { recursive: true });
await mkdir(maaCacheDir, { recursive: true });
await mkdir(join(xdgConfigHome, 'maa'), { recursive: true });

await writeFile(fakeCliPath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'dir') {
  const dirs = {
    cache: process.env.FAKE_MAA_CACHE_DIR,
    log: process.env.FAKE_MAA_LOG_DIR,
    config: process.env.FAKE_MAA_CONFIG_DIR,
    resource: process.env.FAKE_MAA_RESOURCE_DIR
  };
  process.stdout.write(dirs[args[1]] || '');
  process.exit(0);
}
fs.appendFileSync(process.env.FAKE_MAA_LOG, args.join(' ') + '\\n');
const delay = Number(process.env.FAKE_MAA_SLEEP_MS || 0);
if (delay > 0) {
  setTimeout(() => process.exit(0), delay);
} else {
  process.stdout.write('fake output\\n');
  process.exit(0);
}
`, { mode: 0o755 });

await writeFile(fakeAdbPath, `#!${process.execPath}
process.stdout.write('Android Debug Bridge version 1.0.41\\n');
`, { mode: 0o755 });

process.env.MAA_CLI_PATH = fakeCliPath;
process.env.ADB_PATH = fakeAdbPath;
process.env.FAKE_MAA_LOG = cliCallLog;
process.env.MAA_CACHE_DIR = maaCacheDir;
process.env.FAKE_MAA_CACHE_DIR = maaCacheDir;
process.env.FAKE_MAA_LOG_DIR = maaLogDir;
process.env.FAKE_MAA_CONFIG_DIR = join(xdgConfigHome, 'maa');
process.env.FAKE_MAA_RESOURCE_DIR = join(xdgDataHome, 'maa', 'resource');
process.env.XDG_DATA_HOME = xdgDataHome;
process.env.XDG_STATE_HOME = xdgStateHome;
process.env.XDG_CONFIG_HOME = xdgConfigHome;
process.env.LA_PLUMA_AGENT_RUN_STORE = join(fixtureDir, 'agent-runs.json');
process.env.LA_PLUMA_MAA_LOCK_FILE = join(fixtureDir, 'maa-execution.lock');
process.env.LA_PLUMA_WEBRTC_DIR = join(fixtureDir, 'webrtc');
process.env.LA_PLUMA_WEBRTC_ICE_SERVERS = '';
process.env.LA_PLUMA_COPILOT_PROGRESS_STORE = join(fixtureDir, 'copilot-progress.json');

const { createLaPlumaApp } = await import('../server.js');
const { WEBRTC_SIGNALING_PATH } = await import('../services/webrtcSignalingGateway.ts');
const { loggerManager } = await import('../utils/logger.ts');

// 真实 HTTP 用例会触发服务日志；控制台输出关闭，避免门禁输出被诊断行淹没。
for (const loggerName of ['Api', 'MaaService', 'AgentRoutes', 'Scheduler', 'AgentRunService']) {
  loggerManager.getLogger(loggerName).enableConsole = false;
}

const servers: Server[] = [];

interface RunSnapshotPayload {
  run: { runId: string; state: string } | null;
  activeRuns: Array<{ runId: string }>;
}

/** `GET /runs/:runId` 返回平铺的 Run DTO；`runs/current` 才带 `run` 字段。 */
interface RunLookupPayload {
  runId: string;
  state: string;
}

interface DryRunPlanPayload {
  dryRun?: boolean;
  plan: unknown;
}

interface ErrorPayload {
  code?: string;
}

interface TaskExecutorPayload {
  runId: string;
  run: { state: string };
}

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

/** 信令网关只用于创建应用；本文件不建立 WebRTC 连接。 */
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

function authorizedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: 'Bearer api-secret', ...extra };
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authorizedHeaders(headers) },
    body: JSON.stringify(body)
  });
}

async function callCliLog(): Promise<string> {
  return await readFile(cliCallLog, 'utf-8').catch(() => '');
}

async function waitForRunState(
  baseUrl: string,
  runId: string,
  states: readonly string[],
  timeoutMs = 8000
): Promise<RunLookupPayload> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/agent/runs/${runId}`, {
      headers: authorizedHeaders()
    });
    if (response.ok) {
      const body = await readSuccess<RunLookupPayload>(response);
      if (states.includes(body.data.state)) return body.data;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} did not reach ${states.join('/')} before timeout`);
}

afterEach(async () => {
  delete process.env.FAKE_MAA_SLEEP_MS;
  while (servers.length) {
    const server = servers.pop();
    assert.ok(server);
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await writeFile(cliCallLog, '', 'utf-8').catch(() => {});
});

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('agent execution HTTP adapter', () => {
  it('requires the API token before parsing any execution entry', async () => {
    const port = await listen(createLaPlumaApp({
      env: { LA_PLUMA_TOKEN: 'api-secret' },
      signalingGateway: stubSignalingGateway(),
      loginRateLimit: { maxAuthFailures: 100 }
    }));
    const baseUrl = `http://127.0.0.1:${port}`;
    const executionRoutes: ReadonlyArray<readonly [string, string]> = [
      ['/api/agent/activity/run', JSON.stringify({})],
      ['/api/agent/copilot-sets/42/execute', JSON.stringify({ mode: 'continuous' })],
      ['/api/agent/actions/continue-copilot-set', JSON.stringify({ runId: 'unknown-run' })],
      ['/api/agent/schedules/manual/execute', JSON.stringify({ taskFlow: [] })],
      ['/api/agent/actions/start-game', JSON.stringify({})],
      ['/api/agent/actions/run-daily-flow', JSON.stringify({ dryRun: true })],
      ['/api/agent/actions/fight', JSON.stringify({ stage: '1-7' })],
      ['/api/agent/actions/run-task', JSON.stringify({ command: 'award' })],
      ['/api/agent/actions/stop', JSON.stringify({ runId: 'unknown-run' })]
    ];

    for (const [path, body] of executionRoutes) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body
      });
      assert.equal(response.status, 401, `${path} must require the API token`);
      const payload = await readError(response);
      assert.equal(payload.error.code, 'AGENT_AUTH_REQUIRED');
    }

    assert.equal(await callCliLog(), '');
  });

  it('rejects malformed bodies with the existing codes before creating a run or spawn', async () => {
    const port = await listen(createLaPlumaApp({
      env: {},
      signalingGateway: stubSignalingGateway()
    }));
    const baseUrl = `http://127.0.0.1:${port}`;
    const invalidRequests: ReadonlyArray<readonly [string, unknown, string]> = [
      ['/api/agent/copilot-sets/42/execute', { mode: 'auto' }, 'AGENT_VALIDATION_COPILOT_SET_MODE_INVALID'],
      ['/api/agent/copilot-sets/42/execute', { selectedIndexes: [-1] }, 'AGENT_VALIDATION_COPILOT_SET_SELECTION_INVALID'],
      ['/api/agent/actions/continue-copilot-set', {}, 'AGENT_VALIDATION_RUN_ID_INVALID'],
      ['/api/agent/schedules/manual/execute', { taskFlow: {} }, 'AGENT_VALIDATION_TASK_FLOW_INVALID'],
      ['/api/agent/schedules/manual/execute', { taskFlow: [], waitForCompletion: 'false' }, 'AGENT_VALIDATION_WAIT_FOR_COMPLETION_INVALID'],
      ['/api/agent/actions/start-game', { waitForCompletion: 'later' }, 'AGENT_VALIDATION_WAIT_FOR_COMPLETION_INVALID'],
      ['/api/agent/actions/run-daily-flow', { dryRun: 'false' }, 'AGENT_VALIDATION_DRY_RUN_INVALID'],
      ['/api/agent/actions/run-daily-flow', { taskFlow: {} }, 'AGENT_VALIDATION_TASK_FLOW_INVALID'],
      ['/api/agent/actions/fight', {}, 'AGENT_VALIDATION_MISSING_STAGES'],
      ['/api/agent/actions/stop', { runId: 42 }, 'AGENT_VALIDATION_RUN_ID_INVALID']
    ];

    for (const [path, body, code] of invalidRequests) {
      const response = await postJson(`${baseUrl}${path}`, body);
      assert.equal(response.status, 400, `${path} must reject malformed input`);
      const payload = await readError(response);
      assert.equal(payload.error.code, code, `${path} error code`);
    }

    const snapshot = await fetch(`${baseUrl}/api/agent/runs/current`, {
      headers: authorizedHeaders()
    });
    const snapshotBody = await readSuccess<RunSnapshotPayload>(snapshot);
    assert.equal(snapshotBody.data.run, null);
    assert.deepEqual(snapshotBody.data.activeRuns, []);
    assert.equal(await callCliLog(), '');
  });

  it('returns the unified error envelope for unknown runs and invalid JSON', async () => {
    const port = await listen(createLaPlumaApp({
      env: {},
      signalingGateway: stubSignalingGateway()
    }));
    const baseUrl = `http://127.0.0.1:${port}`;

    const stop = await postJson(`${baseUrl}/api/agent/actions/stop`, {
      runId: '00000000-0000-4000-8000-000000000000'
    });
    assert.equal(stop.status, 404);
    assert.equal((await readError(stop)).error.code, 'AGENT_RUN_NOT_FOUND');

    const resume = await postJson(`${baseUrl}/api/agent/actions/continue-copilot-set`, {
      runId: '00000000-0000-4000-8000-000000000000'
    });
    assert.equal(resume.status, 404);
    assert.equal((await readError(resume)).error.code, 'AGENT_RUN_NOT_FOUND');

    const malformed = await fetch(`${baseUrl}/api/agent/actions/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authorizedHeaders() },
      body: '{'
    });
    assert.equal(malformed.status, 400);
    const malformedPayload = await readError(malformed);
    assert.equal(malformedPayload.error.code, 'AGENT_REQUEST_BODY_INVALID');

    assert.equal(await callCliLog(), '');
  });

  it('serves daily-flow and fight dry runs without creating a run or calling the CLI', async () => {
    const port = await listen(createLaPlumaApp({
      env: {},
      signalingGateway: stubSignalingGateway()
    }));
    const baseUrl = `http://127.0.0.1:${port}`;

    const dailyFlow = await postJson(`${baseUrl}/api/agent/actions/run-daily-flow`, {
      dryRun: true,
      scheduleId: 'contract-test',
      taskFlow: [{ id: 'award-1', commandId: 'award', name: '领取奖励', enabled: true }]
    });
    assert.equal(dailyFlow.status, 200);
    const dailyFlowBody = await readSuccess<DryRunPlanPayload & { scheduleId: string; totalSteps: number }>(dailyFlow);
    assert.equal(dailyFlowBody.meta.dryRun, true);
    assert.equal(dailyFlowBody.data.dryRun, true);
    assert.equal(dailyFlowBody.data.scheduleId, 'contract-test');
    assert.equal(dailyFlowBody.data.totalSteps, 1);
    assert.deepEqual(dailyFlowBody.data.plan, [{
      index: 1,
      id: 'award-1',
      name: '领取奖励',
      command: 'award',
      args: [],
      dynamicTask: false
    }]);

    const fight = await postJson(`${baseUrl}/api/agent/actions/fight`, {
      dryRun: true,
      stage: '1-7',
      times: 3
    });
    assert.equal(fight.status, 200);
    const fightBody = await readSuccess<{ plan: { command: string; args: string[] } }>(fight);
    assert.equal(fightBody.meta.dryRun, true);
    assert.equal(fightBody.data.plan.command, 'fight');
    // 既有 buildFightArgs 对缺省数值参数仍显式输出 0；dryRun 只展示计划。
    assert.deepEqual(fightBody.data.plan.args, [
      '1-7:3', '-m', '0', '--expiring-medicine', '0', '--stone', '0', '--series', '0'
    ]);

    const snapshot = await fetch(`${baseUrl}/api/agent/runs/current`, { headers: authorizedHeaders() });
    const snapshotBody = await readSuccess<RunSnapshotPayload>(snapshot);
    assert.equal(snapshotBody.data.run, null);
    assert.equal(await callCliLog(), '');
  });

  it('replays one idempotent task submission over real HTTP without executing twice', async () => {
    const port = await listen(createLaPlumaApp({
      env: {},
      signalingGateway: stubSignalingGateway()
    }));
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = { 'Idempotency-Key': 'http-task:replay:1' };

    const first = await postJson(`${baseUrl}/api/agent/actions/run-task`, { command: 'award' }, headers);
    assert.equal(first.status, 200);
    const firstBody = await readSuccess<TaskExecutorPayload>(first);
    assert.equal(firstBody.data.run.state, 'succeeded');
    assert.equal(first.headers.get('Idempotency-Replayed'), 'false');
    const runId = firstBody.data.runId;

    const replay = await postJson(`${baseUrl}/api/agent/actions/run-task`, { command: 'award' }, headers);
    assert.equal(replay.status, 200);
    const replayBody = await readSuccess<TaskExecutorPayload>(replay);
    assert.equal(replayBody.data.runId, runId);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.equal(replayBody.data.run.state, 'succeeded');

    const calls = (await callCliLog()).split('\n').filter(line => line.startsWith('award'));
    assert.equal(calls.length, 1, 'the idempotent replay must not spawn a second command');
  });

  it('stops a targeted background run over real HTTP', async () => {
    process.env.FAKE_MAA_SLEEP_MS = '3000';
    const port = await listen(createLaPlumaApp({
      env: {},
      signalingGateway: stubSignalingGateway()
    }));
    const baseUrl = `http://127.0.0.1:${port}`;

    const started = await postJson(`${baseUrl}/api/agent/actions/run-task`, {
      command: 'award',
      waitForCompletion: false
    });
    if (started.status !== 202) {
      const failure = await readError(started);
      assert.fail(`unexpected status ${started.status}: ${failure.message} ${failure.error.code}`);
    }
    const startedBody = await readSuccess<TaskExecutorPayload>(started);
    const runId = startedBody.data.runId;
    assert.equal(startedBody.data.run.state, 'running');
    assert.equal(started.headers.get('Location'), `/api/agent/runs/${runId}`);

    const stopped = await postJson(`${baseUrl}/api/agent/actions/stop`, { runId });
    assert.equal(stopped.status, 200);
    const stoppedBody = await readSuccess<{ stopRequested: boolean; deviceStopRequested: boolean; run: { state: string } }>(stopped);
    assert.equal(stoppedBody.data.stopRequested, true);
    assert.equal(stoppedBody.data.deviceStopRequested, true);
    assert.equal(stoppedBody.data.run.state, 'stopping');

    const terminal = await waitForRunState(baseUrl, runId, ['stopped']);
    assert.equal(terminal.state, 'stopped');

    const repeated = await postJson(`${baseUrl}/api/agent/actions/stop`, { runId });
    assert.equal(repeated.status, 200);
    const repeatedBody = await readSuccess<{ alreadyTerminal: boolean }>(repeated);
    assert.equal(repeatedBody.data.alreadyTerminal, true);
  });
});
