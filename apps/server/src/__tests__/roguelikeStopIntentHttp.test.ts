import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import type { ApiErrorResponse, ApiSuccessResponse } from '../utils/apiHelper.ts';
import type { RoguelikeStopIntentTimer } from '../services/roguelikeStopIntentService.ts';
import type { WebrtcSignalingGateway } from '../services/webrtcSignalingGateway.ts';

const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-stop-intent-http-'));
const maaLogDir = join(fixtureDir, 'maa-logs');
const maaCacheDir = join(fixtureDir, 'maa-cache');
const xdgDataHome = join(fixtureDir, 'xdg-data');
const xdgStateHome = join(fixtureDir, 'xdg-state');
const xdgConfigHome = join(fixtureDir, 'xdg-config');
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');
const fakeAdbPath = join(fixtureDir, 'fake-adb.js');
const cliCallLog = join(fixtureDir, 'maa-calls.log');
const asstLogPath = join(maaLogDir, 'asst.log');

await mkdir(maaLogDir, { recursive: true });
await mkdir(maaCacheDir, { recursive: true });
await mkdir(join(xdgConfigHome, 'maa'), { recursive: true });
await writeFile(asstLogPath, '');

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
fs.appendFileSync(process.env.FAKE_MAA_CALL_LOG, args.join(' ') + '\\n');
const delay = Number(process.env.FAKE_MAA_SLEEP_MS || 0);
const finish = () => {
  process.stdout.write('fake output\\n');
  process.exit(0);
};
if (delay > 0) setTimeout(finish, delay);
else finish();
`, { mode: 0o755 });

await writeFile(fakeAdbPath, `#!${process.execPath}
process.stdout.write('Android Debug Bridge version 1.0.41\\n');
`, { mode: 0o755 });

process.env.MAA_CLI_PATH = fakeCliPath;
process.env.ADB_PATH = fakeAdbPath;
process.env.MAA_CACHE_DIR = maaCacheDir;
process.env.FAKE_MAA_CACHE_DIR = maaCacheDir;
process.env.FAKE_MAA_LOG_DIR = maaLogDir;
process.env.FAKE_MAA_CONFIG_DIR = join(xdgConfigHome, 'maa');
process.env.FAKE_MAA_RESOURCE_DIR = join(xdgDataHome, 'maa', 'resource');
process.env.FAKE_MAA_CALL_LOG = cliCallLog;
process.env.XDG_DATA_HOME = xdgDataHome;
process.env.XDG_STATE_HOME = xdgStateHome;
process.env.XDG_CONFIG_HOME = xdgConfigHome;
process.env.LA_PLUMA_AGENT_RUN_STORE = join(fixtureDir, 'agent-runs.json');
process.env.LA_PLUMA_MAA_LOCK_FILE = join(fixtureDir, 'maa-execution.lock');
process.env.LA_PLUMA_WEBRTC_DIR = join(fixtureDir, 'webrtc');
process.env.LA_PLUMA_WEBRTC_ICE_SERVERS = '';
process.env.LA_PLUMA_COPILOT_PROGRESS_STORE = join(fixtureDir, 'copilot-progress.json');

const { createLaPlumaApp } = await import('../app.ts');
const {
  configureRoguelikeStopIntentRuntimeForTests,
  getRoguelikeStopIntent,
  resetRoguelikeStopIntentForTests
} = await import('../services/roguelikeStopIntentService.ts');
const { stopCurrentTask } = await import('../services/maaProcessService.ts');
const { WEBRTC_SIGNALING_PATH } = await import('../services/webrtcSignalingGateway.ts');
const { loggerManager } = await import('../utils/logger.ts');

for (const loggerName of ['Api', 'MaaService', 'AgentRoutes', 'Scheduler', 'AgentRunService', 'RoguelikeStopIntent']) {
  loggerManager.getLogger(loggerName).enableConsole = false;
}

const servers: Server[] = [];

interface StopPayload {
  stopRequested: boolean;
  deviceStopRequested: boolean;
  pendingStop?: {
    mode: string;
    requestedAt: string;
    deadline: string;
    combat: boolean | null;
  };
  alreadyPending?: boolean;
  alreadyTerminal?: boolean;
  run: {
    runId: string;
    state: string;
    progress?: {
      message?: string;
      stopIntent?: {
        mode: string;
        requestedAt: string;
        deadline: string;
        combat: boolean | null;
      };
    };
  };
}

interface RunPayload {
  runId: string;
  state: string;
  startedAt: string | null;
  progress?: StopPayload['run']['progress'];
}

interface TaskExecutorPayload {
  runId: string;
  run: { state: string; startedAt: string | null };
}

interface TimerEntry {
  callback: () => void;
  cancelled: boolean;
  fired: boolean;
}

function createManualScheduler() {
  const timers: TimerEntry[] = [];
  const nowMs = Date.now();
  const scheduler = {
    now: () => nowMs,
    schedule(callback: () => void): RoguelikeStopIntentTimer {
      const entry: TimerEntry = { callback, cancelled: false, fired: false };
      timers.push(entry);
      return { cancel: () => { entry.cancelled = true; } };
    }
  };
  return {
    scheduler,
    pendingCount: () => timers.filter(timer => !timer.cancelled && !timer.fired).length,
    fire() {
      const timer = timers.find(candidate => !candidate.cancelled && !candidate.fired);
      assert.ok(timer, 'expected a scheduled stop intent poll');
      timer.fired = true;
      timer.callback();
    }
  };
}

let manual = createManualScheduler();
let deviceStopCalls = 0;

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
  return body as ApiErrorResponse;
}

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

async function listen(): Promise<string> {
  const app = createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function fetchRun(baseUrl: string, runId: string): Promise<RunPayload> {
  const response = await fetch(`${baseUrl}/api/agent/runs/${runId}`);
  assert.equal(response.status, 200);
  return (await readSuccess<RunPayload>(response)).data;
}

async function waitForRunState(
  baseUrl: string,
  runId: string,
  states: readonly string[],
  timeoutMs = 8000
): Promise<RunPayload> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await fetchRun(baseUrl, runId);
    if (states.includes(run.state)) return run;
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} did not reach ${states.join('/')} before timeout`);
}

async function startBackgroundRun(baseUrl: string, body: Record<string, unknown>): Promise<RunPayload> {
  const response = await postJson(`${baseUrl}/api/agent/actions/run-task`, {
    ...body,
    waitForCompletion: false
  });
  if (response.status !== 202) {
    const failure = await readError(response);
    assert.fail(`run-task returned ${response.status}: ${failure.message} ${failure.error.code}`);
  }
  const data = (await readSuccess<TaskExecutorPayload>(response)).data;
  return waitForRunState(baseUrl, data.runId, ['running']);
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

function formatLogTime(timeMs: number): string {
  const date = new Date(timeMs);
  return `[${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}]`;
}

async function appendCombatCallback(run: RunPayload, what: string, offsetMs: number): Promise<void> {
  assert.ok(run.startedAt, 'run.startedAt must be set before writing callbacks');
  const timeMs = Date.parse(run.startedAt) + offsetMs;
  const line = `${formatLogTime(timeMs)}[INF] Assistant::append_callback | SubTaskExtraInfo ${JSON.stringify({
    taskchain: 'Roguelike',
    what,
    details: {}
  })}\n`;
  await appendFile(asstLogPath, line, 'utf-8');
}

function expectPendingStop(payload: StopPayload): NonNullable<StopPayload['pendingStop']> {
  assert.ok(payload.pendingStop, 'response must carry pendingStop');
  assert.equal(payload.pendingStop.mode, 'after-combat');
  assert.equal(payload.pendingStop.combat, true);
  assert.equal(Number.isNaN(Date.parse(payload.pendingStop.requestedAt)), false);
  assert.equal(Number.isNaN(Date.parse(payload.pendingStop.deadline)), false);
  return payload.pendingStop;
}

beforeEach(() => {
  manual = createManualScheduler();
  deviceStopCalls = 0;
  configureRoguelikeStopIntentRuntimeForTests({
    scheduler: manual.scheduler,
    stopDeviceTask: () => {
      deviceStopCalls += 1;
      return stopCurrentTask();
    }
  });
});

afterEach(async () => {
  resetRoguelikeStopIntentForTests();
  delete process.env.FAKE_MAA_SLEEP_MS;
  while (servers.length) {
    const server = servers.pop();
    assert.ok(server);
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  stopCurrentTask();
  await writeFile(asstLogPath, '').catch(() => {});
});

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('stop after combat over HTTP', () => {
  it('rejects explicit null and unknown stop modes while an omitted mode stays now', async () => {
    const baseUrl = await listen();
    const url = `${baseUrl}/api/agent/actions/stop`;

    for (const body of [{ mode: 'later' }, { mode: null }, { mode: 42 }]) {
      const response = await postJson(url, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal((await readError(response)).error.code, 'AGENT_VALIDATION_STOP_MODE_INVALID');
    }

    assert.equal((await postJson(url, {})).status, 200);
    assert.equal((await fetch(url, { method: 'POST' })).status, 200);
  });

  it('falls back to an immediate stop for a non-roguelike run', async () => {
    process.env.FAKE_MAA_SLEEP_MS = '20000';
    const baseUrl = await listen();
    const run = await startBackgroundRun(baseUrl, { command: 'startup' });

    const response = await postJson(`${baseUrl}/api/agent/actions/stop`, { runId: run.runId, mode: 'after-combat' });

    assert.equal(response.status, 200);
    const payload = (await readSuccess<StopPayload>(response)).data;
    assert.equal(payload.stopRequested, true);
    assert.equal(payload.deviceStopRequested, true);
    assert.equal(payload.pendingStop, undefined);
    assert.equal(payload.run.state, 'stopping');
    assert.equal(getRoguelikeStopIntent(run.runId), null);
    assert.equal(manual.pendingCount(), 0);
    await waitForRunState(baseUrl, run.runId, ['stopped']);
  });

  it('falls back to an immediate stop when the roguelike run is not in combat', async () => {
    process.env.FAKE_MAA_SLEEP_MS = '20000';
    const baseUrl = await listen();
    const run = await startBackgroundRun(baseUrl, { command: 'roguelike', args: ['Mizuki'] });

    const response = await postJson(`${baseUrl}/api/agent/actions/stop`, { runId: run.runId, mode: 'after-combat' });

    assert.equal(response.status, 200);
    const payload = (await readSuccess<StopPayload>(response)).data;
    assert.equal(payload.stopRequested, true);
    assert.equal(payload.deviceStopRequested, true);
    assert.equal(payload.pendingStop, undefined);
    assert.equal(getRoguelikeStopIntent(run.runId), null);
    await waitForRunState(baseUrl, run.runId, ['stopped']);
  });

  it('defers a fighting roguelike run, keeps it running and sends the stop after RoguelikeCombatEnd', async () => {
    process.env.FAKE_MAA_SLEEP_MS = '20000';
    const baseUrl = await listen();
    const run = await startBackgroundRun(baseUrl, { command: 'roguelike', args: ['Mizuki'] });
    await appendCombatCallback(run, 'StageInfo', 1000);

    const response = await postJson(`${baseUrl}/api/agent/actions/stop`, { runId: run.runId, mode: 'after-combat' });

    assert.equal(response.status, 200);
    const payload = (await readSuccess<StopPayload>(response)).data;
    const pendingStop = expectPendingStop(payload);
    assert.equal(payload.stopRequested, true);
    assert.equal(payload.deviceStopRequested, false);
    assert.equal(payload.alreadyPending, undefined);
    assert.equal(payload.run.state, 'running');
    assert.deepEqual(payload.run.progress?.stopIntent, pendingStop);
    assert.equal(payload.run.progress?.message, '等待战斗结束后终止');
    assert.equal(deviceStopCalls, 0);
    assert.equal(manual.pendingCount(), 1);

    const repeated = await postJson(`${baseUrl}/api/agent/actions/stop`, { runId: run.runId, mode: 'after-combat' });

    assert.equal(repeated.status, 200);
    const repeatedPayload = (await readSuccess<StopPayload>(repeated)).data;
    assert.equal(repeatedPayload.alreadyPending, true);
    assert.deepEqual(repeatedPayload.pendingStop, pendingStop);
    assert.equal(manual.pendingCount(), 1);

    await appendCombatCallback(run, 'RoguelikeCombatEnd', 5000);
    manual.fire();
    await waitForRunState(baseUrl, run.runId, ['stopped']);

    assert.equal(deviceStopCalls, 1);
    assert.equal(getRoguelikeStopIntent(run.runId), null);
    const terminal = await fetchRun(baseUrl, run.runId);
    assert.equal(terminal.progress, undefined);
  });

  it('cancels a pending after-combat stop when mode=now is requested', async () => {
    process.env.FAKE_MAA_SLEEP_MS = '20000';
    const baseUrl = await listen();
    const run = await startBackgroundRun(baseUrl, { command: 'roguelike', args: ['Mizuki'] });
    await appendCombatCallback(run, 'StageInfo', 1000);
    const deferred = await postJson(`${baseUrl}/api/agent/actions/stop`, { runId: run.runId, mode: 'after-combat' });
    assert.equal(deferred.status, 200);
    expectPendingStop((await readSuccess<StopPayload>(deferred)).data);
    assert.equal(manual.pendingCount(), 1);

    const response = await postJson(`${baseUrl}/api/agent/actions/stop`, { runId: run.runId, mode: 'now' });

    assert.equal(response.status, 200);
    const payload = (await readSuccess<StopPayload>(response)).data;
    assert.equal(payload.stopRequested, true);
    assert.equal(payload.deviceStopRequested, true);
    assert.equal(payload.pendingStop, undefined);
    assert.equal(payload.run.state, 'stopping');
    assert.equal(getRoguelikeStopIntent(run.runId), null);
    assert.equal(manual.pendingCount(), 0);
    assert.equal(deviceStopCalls, 0);

    const stopping = await fetchRun(baseUrl, run.runId);
    assert.equal(stopping.progress?.stopIntent, undefined);
    await waitForRunState(baseUrl, run.runId, ['stopped']);
  });
});
