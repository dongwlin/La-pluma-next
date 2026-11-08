import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import type { ApiErrorResponse, ApiSuccessResponse } from '../utils/apiHelper.ts';
import type { WebrtcSignalingGateway } from '../services/webrtcSignalingGateway.ts';

const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-copilot-queue-http-'));
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');
const cliCallLog = join(fixtureDir, 'maa-calls.log');
const maaLogDir = join(fixtureDir, 'maa-logs');
const xdgDataHome = join(fixtureDir, 'xdg-data');
const xdgStateHome = join(fixtureDir, 'xdg-state');
const xdgConfigHome = join(fixtureDir, 'xdg-config');
const maaConfigDir = join(xdgConfigHome, 'maa');
const resourceDir = join(xdgDataHome, 'maa', 'resource');

await mkdir(maaLogDir, { recursive: true });
await mkdir(maaConfigDir, { recursive: true });
await mkdir(join(resourceDir, 'Arknights-Tile-Pos'), { recursive: true });
await mkdir(join(fixtureDir, 'maa-cache'), { recursive: true });
await writeFile(join(resourceDir, 'stages.json'), '[]');
await writeFile(join(maaLogDir, 'asst.log'), '');
await writeFile(cliCallLog, '');

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
const finish = () => {
  process.stdout.write('fake output\\n');
  process.exit(0);
};
const delay = Number(process.env.FAKE_MAA_SLEEP_MS || 0);
if (delay > 0) {
  setTimeout(finish, delay);
} else {
  finish();
}
`, { mode: 0o755 });

process.env.MAA_CLI_PATH = fakeCliPath;
process.env.MAA_CACHE_DIR = join(fixtureDir, 'maa-cache');
process.env.FAKE_MAA_CACHE_DIR = join(fixtureDir, 'maa-cache');
process.env.FAKE_MAA_LOG = cliCallLog;
process.env.FAKE_MAA_LOG_DIR = maaLogDir;
process.env.FAKE_MAA_CONFIG_DIR = maaConfigDir;
process.env.FAKE_MAA_RESOURCE_DIR = resourceDir;
process.env.XDG_DATA_HOME = xdgDataHome;
process.env.XDG_STATE_HOME = xdgStateHome;
process.env.XDG_CONFIG_HOME = xdgConfigHome;
process.env.LA_PLUMA_AGENT_RUN_STORE = join(fixtureDir, 'agent-runs.json');
process.env.LA_PLUMA_MAA_LOCK_FILE = join(fixtureDir, 'maa-execution.lock');
process.env.LA_PLUMA_COPILOT_PROGRESS_STORE = join(fixtureDir, 'copilot-progress.json');
process.env.LA_PLUMA_DROP_RECORDS_DIR = join(fixtureDir, 'drop-records');
process.env.LA_PLUMA_WEBRTC_DIR = join(fixtureDir, 'webrtc');
process.env.LA_PLUMA_WEBRTC_ICE_SERVERS = '';

const { createLaPlumaApp } = await import('../app.ts');
const { listAgentRuns } = await import('../services/agentRunService.ts');
const { resolveAppPaths } = await import('../config/runtimeConfig.ts');
const { WEBRTC_SIGNALING_PATH } = await import('../services/webrtcSignalingGateway.ts');
const { loggerManager } = await import('../utils/logger.ts');

for (const loggerName of ['Api', 'MaaService', 'AgentRoutes', 'Scheduler', 'AgentRunService', 'CopilotPlan']) {
  loggerManager.getLogger(loggerName).enableConsole = false;
}

const servers: Server[] = [];
const originalFetch = globalThis.fetch;

interface RunSnapshotPayload {
  run: { runId: string; state: string } | null;
  activeRuns: Array<{ runId: string }>;
}

interface QueueRunPayload {
  runId: string;
  state: string;
  accepted?: boolean;
  mode?: string;
  queueId?: string;
  name?: string;
  failurePolicy?: string;
  waitingForNext?: boolean;
  finished?: boolean;
  nextEntry?: { clientId: string; itemIndex: number; stage: string; mode: string } | null;
  summary?: QueueSummaryPayload;
  result?: { summary?: QueueSummaryPayload };
  run?: QueueRunPayload;
}

interface RunLookupPayload {
  runId: string;
  state: string;
  result?: { summary?: QueueSummaryPayload };
}

interface QueueSummaryPayload {
  queueId: string;
  mode: string;
  failurePolicy: string;
  totalEntries: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  stoppedCount: number;
  pendingCount: number;
  errors: Array<{ clientId: string; stage: string; error: string }>;
  taskResults: Array<{ clientId: string; status: string; error?: string }>;
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

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function waitForRunState(
  baseUrl: string,
  runId: string,
  states: readonly string[],
  timeoutMs = 8000
): Promise<RunLookupPayload> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/agent/runs/${runId}`);
    if (response.ok) {
      const body = await readSuccess<RunLookupPayload>(response);
      if (states.includes(body.data.state)) return body.data;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} did not reach ${states.join('/')} before timeout`);
}

function copilotContent(stageName: string): Response {
  return new Response(JSON.stringify({
    status_code: 200,
    data: {
      content: JSON.stringify({
        stage_name: stageName,
        doc: { title: '1-7' },
        opers: [{ name: 'A' }],
        groups: []
      })
    }
  }), { status: 200 });
}

beforeEach(() => {
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://prts.maa.plus/')) {
      const match = url.match(/copilot\/get\/(\d+)$/);
      if (match) return copilotContent('main_01-01');
      return new Response(JSON.stringify({ status_code: 200, data: { copilot_ids: [] } }), { status: 200 });
    }
    if (url.startsWith('https://penguin-stats.io/')) {
      return new Response(JSON.stringify({ status_code: 200, data: [] }), { status: 200 });
    }
    return originalFetch(input, init);
  };
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  delete process.env.FAKE_MAA_SLEEP_MS;
  await rm(join(fixtureDir, 'copilot-progress.json'), { force: true });
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

function remoteEntries(count = 2): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    clientId: `queue-${index}`,
    source: 'prts',
    copilotId: 300 + index,
    mode: index % 2 === 0 ? 'normal' : 'raid'
  }));
}

function queueBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    queueId: 'http-queue',
    name: 'HTTP 作业队列',
    mode: 'continuous',
    failurePolicy: 'stop',
    entries: remoteEntries(),
    waitForCompletion: true,
    ...overrides
  };
}

describe('copilot queue HTTP routes', () => {
  it('executes a queue synchronously and returns the terminal summary', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const baseUrl = `http://127.0.0.1:${port}`;

    const response = await postJson(`${baseUrl}/api/agent/copilot-queues/execute`, queueBody());
    assert.equal(response.status, 200);
    const body = await readSuccess<QueueRunPayload>(response);

    assert.equal(body.data.state, 'succeeded');
    assert.equal(body.data.queueId, 'http-queue');
    assert.equal(body.data.mode, 'continuous');
    assert.equal(body.data.failurePolicy, 'stop');
    assert.equal(body.data.summary?.successCount, 2);
    assert.equal(body.data.summary?.totalEntries, 2);
    assert.deepEqual(
      body.data.summary?.taskResults.map(item => [item.clientId, item.status]),
      [['queue-0', 'success'], ['queue-1', 'success']]
    );

    const lookup = await fetch(`${baseUrl}/api/agent/runs/${body.data.runId}`);
    const lookupBody = await readSuccess<RunLookupPayload>(lookup);
    assert.equal(lookupBody.data.state, 'succeeded');
    assert.equal(lookupBody.data.result?.summary?.successCount, 2);
  });

  it('accepts a background queue with 202 and settles the run afterwards', async () => {
    process.env.FAKE_MAA_SLEEP_MS = '150';
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const baseUrl = `http://127.0.0.1:${port}`;

    const response = await postJson(`${baseUrl}/api/agent/copilot-queues/execute`, queueBody({
      failurePolicy: 'continue',
      waitForCompletion: false,
      entries: remoteEntries(1)
    }));
    assert.equal(response.status, 202);
    const body = await readSuccess<QueueRunPayload>(response);
    assert.equal(body.data.accepted, true);
    assert.ok(['accepted', 'running'].includes(body.data.state));
    assert.equal(body.data.queueId, 'http-queue');

    const terminal = await waitForRunState(baseUrl, body.data.runId, ['succeeded']);
    assert.equal(terminal.result?.summary?.successCount, 1);
    assert.equal(terminal.result?.summary?.failurePolicy, 'continue');
  });

  it('waits after the first manual entry and executes the next entry on continue', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const baseUrl = `http://127.0.0.1:${port}`;

    const first = await postJson(`${baseUrl}/api/agent/copilot-queues/execute`, queueBody({
      mode: 'manual',
      entries: remoteEntries(3)
    }));
    assert.equal(first.status, 200);
    const firstBody = await readSuccess<QueueRunPayload>(first);
    assert.equal(firstBody.data.state, 'waiting');
    assert.equal(firstBody.data.waitingForNext, true);
    assert.equal(firstBody.data.nextEntry?.clientId, 'queue-1');
    assert.equal(firstBody.data.summary?.successCount, 1);

    const snapshot = await fetch(`${baseUrl}/api/agent/runs/${firstBody.data.runId}`);
    const snapshotBody = await readSuccess<RunLookupPayload>(snapshot);
    assert.equal(snapshotBody.data.state, 'waiting');

    const second = await postJson(`${baseUrl}/api/agent/actions/continue-copilot-queue`, {
      runId: firstBody.data.runId,
      waitForCompletion: true
    });
    assert.equal(second.status, 200);
    const secondBody = await readSuccess<QueueRunPayload>(second);
    assert.equal(secondBody.data.state, 'waiting');
    assert.equal(secondBody.data.waitingForNext, true);
    assert.equal(secondBody.data.nextEntry?.clientId, 'queue-2');
    assert.equal(secondBody.data.summary?.successCount, 2);

    const third = await postJson(`${baseUrl}/api/agent/actions/continue-copilot-queue`, {
      runId: firstBody.data.runId,
      waitForCompletion: true
    });
    assert.equal(third.status, 200);
    const thirdBody = await readSuccess<QueueRunPayload>(third);
    assert.equal(thirdBody.data.state, 'succeeded');
    assert.equal(thirdBody.data.summary?.successCount, 3);

    const terminalContinue = await postJson(`${baseUrl}/api/agent/actions/continue-copilot-queue`, {
      runId: firstBody.data.runId
    });
    assert.equal(terminalContinue.status, 200);
    const terminalBody = await readSuccess<Record<string, unknown>>(terminalContinue);
    assert.equal(terminalBody.data.alreadyTerminal, true);
    assert.equal(terminalBody.data.finished, true);
  });

  it('skips the next manual entry and finishes the run when nothing is pending', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const baseUrl = `http://127.0.0.1:${port}`;

    const submitted = await postJson(`${baseUrl}/api/agent/copilot-queues/execute`, queueBody({
      mode: 'manual',
      entries: remoteEntries(2)
    }));
    const submittedBody = await readSuccess<QueueRunPayload>(submitted);
    assert.equal(submittedBody.data.state, 'waiting');

    const skipped = await postJson(`${baseUrl}/api/agent/actions/skip-copilot-queue-entry`, {
      runId: submittedBody.data.runId
    });
    assert.equal(skipped.status, 200);
    const skippedBody = await readSuccess<Record<string, unknown>>(skipped);
    assert.equal(skippedBody.data.skippedClientId, 'queue-1');
    assert.equal(skippedBody.data.waitingForNext, false);
    assert.equal(skippedBody.data.finished, true);
    const skippedRun = skippedBody.data.run as QueueRunPayload;
    assert.equal(skippedRun.state, 'succeeded');
    assert.equal(skippedRun.result?.summary?.skippedCount, 1);
    assert.equal(skippedRun.result?.summary?.successCount, 1);
  });

  it('stops a waiting queue, and rejects continue or skip afterwards', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const baseUrl = `http://127.0.0.1:${port}`;

    const submitted = await postJson(`${baseUrl}/api/agent/copilot-queues/execute`, queueBody({
      mode: 'manual',
      entries: remoteEntries(2)
    }));
    const submittedBody = await readSuccess<QueueRunPayload>(submitted);
    const runId = submittedBody.data.runId;

    const stopped = await postJson(`${baseUrl}/api/agent/actions/stop`, { runId });
    assert.equal(stopped.status, 200);
    const stoppedBody = await readSuccess<Record<string, unknown>>(stopped);
    assert.equal(stoppedBody.data.waitingRunStopped, true);
    const stoppedRun = stoppedBody.data.run as QueueRunPayload;
    assert.equal(stoppedRun.state, 'stopped');
    assert.equal(stoppedRun.result?.summary?.pendingCount, 1);

    const continueResponse = await postJson(`${baseUrl}/api/agent/actions/continue-copilot-queue`, { runId });
    assert.equal(continueResponse.status, 200);
    const continueBody = await readSuccess<Record<string, unknown>>(continueResponse);
    assert.equal(continueBody.data.alreadyTerminal, true);

    const secondSubmission = await postJson(`${baseUrl}/api/agent/copilot-queues/execute`, queueBody({
      mode: 'manual',
      entries: remoteEntries(2)
    }));
    const secondBody = await readSuccess<QueueRunPayload>(secondSubmission);
    const globalStop = await postJson(`${baseUrl}/api/agent/actions/stop`, {});
    assert.equal(globalStop.status, 200);
    const globalBody = await readSuccess<Record<string, unknown>>(globalStop);
    assert.equal(globalBody.data.waitingRunStopped, true);
    const globalRun = globalBody.data.run as QueueRunPayload;
    assert.equal(globalRun.runId, secondBody.data.runId);
    assert.equal(globalRun.state, 'stopped');
  });

  it('rejects continuing or skipping a queue that is not waiting', async () => {
    process.env.FAKE_MAA_SLEEP_MS = '200';
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const baseUrl = `http://127.0.0.1:${port}`;

    const submitted = await postJson(`${baseUrl}/api/agent/copilot-queues/execute`, queueBody({
      waitForCompletion: false,
      entries: remoteEntries(1)
    }));
    if (submitted.status === 202) {
      const submittedBody = await readSuccess<QueueRunPayload>(submitted);
      const runId = submittedBody.data.runId;
      const running = await waitForRunState(baseUrl, runId, ['running']);
      assert.equal(running.state, 'running');

      const continueResponse = await postJson(`${baseUrl}/api/agent/actions/continue-copilot-queue`, { runId });
      assert.equal(continueResponse.status, 409);
      assert.equal((await readError(continueResponse)).error.code, 'AGENT_COPILOT_QUEUE_NOT_WAITING');

      const skipResponse = await postJson(`${baseUrl}/api/agent/actions/skip-copilot-queue-entry`, { runId });
      assert.equal(skipResponse.status, 409);
      assert.equal((await readError(skipResponse)).error.code, 'AGENT_COPILOT_QUEUE_NOT_WAITING');

      await waitForRunState(baseUrl, runId, ['succeeded']);
    }

    const unknownContinue = await postJson(`${baseUrl}/api/agent/actions/continue-copilot-queue`, {
      runId: '00000000-0000-4000-8000-000000000000'
    });
    assert.equal(unknownContinue.status, 404);
    assert.equal((await readError(unknownContinue)).error.code, 'AGENT_RUN_NOT_FOUND');

    const unknownSkip = await postJson(`${baseUrl}/api/agent/actions/skip-copilot-queue-entry`, {
      runId: '00000000-0000-4000-8000-000000000000'
    });
    assert.equal(unknownSkip.status, 404);
    assert.equal((await readError(unknownSkip)).error.code, 'AGENT_RUN_NOT_FOUND');
  });

  it('rejects malformed queue requests before creating a run', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const baseUrl = `http://127.0.0.1:${port}`;
    const managedMissing = join(resolveAppPaths().appDataDir, 'copilot-imports', 'missing-queue-fixture.json');

    const invalidRequests: ReadonlyArray<readonly [unknown, string]> = [
      [{}, 'AGENT_VALIDATION_COPILOT_QUEUE_ENTRIES_INVALID'],
      [{ entries: [] }, 'AGENT_VALIDATION_COPILOT_QUEUE_ENTRIES_INVALID'],
      [{ entries: remoteEntries(51) }, 'AGENT_VALIDATION_COPILOT_QUEUE_ENTRIES_INVALID'],
      [
        { entries: [{ clientId: 'dup', source: 'prts', copilotId: 1 }, { clientId: 'dup', source: 'prts', copilotId: 2 }] },
        'AGENT_VALIDATION_COPILOT_QUEUE_CLIENT_ID_DUPLICATE'
      ],
      [{ entries: [{ clientId: 'bad id', source: 'prts', copilotId: 1 }] }, 'AGENT_VALIDATION_COPILOT_QUEUE_CLIENT_ID_INVALID'],
      [{ entries: [{ clientId: 'a', source: 'remote', copilotId: 1 }] }, 'AGENT_VALIDATION_COPILOT_QUEUE_SOURCE_INVALID'],
      [{ entries: [{ clientId: 'a', source: 'prts' }] }, 'AGENT_VALIDATION_COPILOT_QUEUE_COPILOT_ID_INVALID'],
      [{ entries: [{ clientId: 'a', source: 'prts', copilotId: 1, mode: 'auto' }] }, 'AGENT_VALIDATION_COPILOT_QUEUE_ENTRY_MODE_INVALID'],
      [
        { entries: [{ clientId: 'a', source: 'file', filename: 'copilot-imports/a.json' }] },
        'AGENT_VALIDATION_COPILOT_QUEUE_FILENAME_INVALID'
      ],
      [
        { entries: [{ clientId: 'a', source: 'file', filename: managedMissing }] },
        'AGENT_VALIDATION_COPILOT_QUEUE_FILE_INVALID'
      ],
      [{ entries: remoteEntries(), mode: 'parallel' }, 'AGENT_VALIDATION_COPILOT_QUEUE_MODE_INVALID'],
      [{ entries: remoteEntries(), failurePolicy: 'abort' }, 'AGENT_VALIDATION_COPILOT_QUEUE_FAILURE_POLICY_INVALID'],
      [{ entries: remoteEntries(), queueId: '../escape' }, 'AGENT_VALIDATION_COPILOT_QUEUE_ID_INVALID'],
      [{ entries: remoteEntries(), options: [] }, 'AGENT_VALIDATION_COPILOT_QUEUE_OPTIONS_INVALID'],
      [{ entries: remoteEntries(), waitForCompletion: 'later' }, 'AGENT_VALIDATION_WAIT_FOR_COMPLETION_INVALID']
    ];

    const runCountBefore = listAgentRuns({ operationId: 'run_copilot_queue' }).length;
    for (const [body, code] of invalidRequests) {
      const response = await postJson(`${baseUrl}/api/agent/copilot-queues/execute`, body);
      assert.equal(response.status, 400, `${JSON.stringify(body)} must be rejected`);
      assert.equal((await readError(response)).error.code, code);
    }
    assert.equal(listAgentRuns({ operationId: 'run_copilot_queue' }).length, runCountBefore);

    const snapshot = await fetch(`${baseUrl}/api/agent/runs/current`);
    const snapshotBody = await readSuccess<RunSnapshotPayload>(snapshot);
    assert.equal(snapshotBody.data.run, null);
    assert.deepEqual(snapshotBody.data.activeRuns, []);
    assert.equal(await readFile(cliCallLog, 'utf8'), '');
  });
});
