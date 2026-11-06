import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import {
  closeHttpServers,
  postJson,
  readError,
  readSuccess,
  silenceLoggers,
  startHttpServer
} from './support/httpTestHelpers.ts';

// 更新入口纳入 Run 后的 HTTP 契约：启动返回 runId、快照可观察、按 runId 停止、
// 失败写入 failed 终态且保持既有错误码。假 CLI 用 Atomics.wait 阻塞，确保停止
// 请求到达时确实是“正在执行的子进程”而不是已经结束的更新。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-update-run-'));
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');
const fakeAdbPath = join(fixtureDir, 'fake-adb.js');
const cliCallLog = join(fixtureDir, 'maa-calls.log');
const xdgDataHome = join(fixtureDir, 'xdg-data');
const xdgStateHome = join(fixtureDir, 'xdg-state');
const xdgConfigHome = join(fixtureDir, 'xdg-config');
const maaConfigDir = join(xdgConfigHome, 'maa');
const resourceDir = join(xdgDataHome, 'maa', 'resource');
const lockFile = join(fixtureDir, 'maa-execution.lock');

await mkdir(maaConfigDir, { recursive: true });
await mkdir(resourceDir, { recursive: true });
await writeFile(join(resourceDir, 'version.json'), JSON.stringify({
  last_updated: new Date().toISOString().slice(0, 10)
}), 'utf-8');

await writeFile(fakeCliPath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_MAA_LOG, args.join(' ') + '\\n');
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleepFor = name => Number(process.env[name] || 0);
if (args[0] === 'version') {
  process.stdout.write('maa-cli v0.7.0\\nMaaCore v6.2.3\\n');
} else if (args[0] === 'dir') {
  const dirs = { resource: process.env.FAKE_MAA_RESOURCE_DIR, 'hot-update': '' };
  process.stdout.write(dirs[args[1]] || '');
} else if (args[0] === 'update' || args[0] === 'install') {
  sleep(sleepFor('FAKE_UPDATE_SLEEP_MS'));
  if (process.env.FAKE_UPDATE_FAIL === '1') {
    process.stderr.write('core update failed\\n');
    process.exit(7);
  }
  process.stdout.write('MaaCore v6.9.9\\n');
} else if (args[0] === 'hot-update') {
  sleep(sleepFor('FAKE_HOT_UPDATE_SLEEP_MS'));
  if (process.env.FAKE_HOT_UPDATE_FAIL === '1') {
    process.stderr.write('hot update failed\\n');
    process.exit(8);
  }
  process.stdout.write('Hot update completed successfully\\n');
} else if (args[0] === 'self') {
  sleep(sleepFor('FAKE_CLI_UPDATE_SLEEP_MS'));
  if (process.env.FAKE_CLI_UPDATE_FAIL === '1') {
    process.stderr.write('self update failed\\n');
    process.exit(9);
  }
  process.stdout.write('cli updated\\n');
} else {
  process.exit(1);
}
`, { mode: 0o755 });

await writeFile(fakeAdbPath, `#!${process.execPath}
process.exit(0);
`, { mode: 0o755 });

process.env.MAA_CLI_PATH = fakeCliPath;
process.env.ADB_PATH = fakeAdbPath;
process.env.FAKE_MAA_LOG = cliCallLog;
process.env.FAKE_MAA_RESOURCE_DIR = resourceDir;
process.env.XDG_DATA_HOME = xdgDataHome;
process.env.XDG_STATE_HOME = xdgStateHome;
process.env.XDG_CONFIG_HOME = xdgConfigHome;
process.env.LA_PLUMA_AGENT_RUN_STORE = join(fixtureDir, 'agent-runs.json');
process.env.LA_PLUMA_MAA_LOCK_FILE = lockFile;
process.env.LA_PLUMA_WEBRTC_DIR = join(fixtureDir, 'webrtc');
process.env.LA_PLUMA_WEBRTC_ICE_SERVERS = '';
process.env.LA_PLUMA_COPILOT_PROGRESS_STORE = join(fixtureDir, 'copilot-progress.json');
process.env.LA_PLUMA_ACTIVITY_COPILOT_PROGRESS_STORE = join(fixtureDir, 'activity-copilot-progress.json');

const { createLaPlumaApp } = await import('../app.ts');

silenceLoggers(['Api', 'MaaService', 'AgentRoutes', 'AgentRunService', 'UpdateService']);

const servers: Server[] = [];
const UPDATE_ENV_KEYS = [
  'FAKE_UPDATE_SLEEP_MS',
  'FAKE_UPDATE_FAIL',
  'FAKE_HOT_UPDATE_SLEEP_MS',
  'FAKE_HOT_UPDATE_FAIL',
  'FAKE_CLI_UPDATE_SLEEP_MS',
  'FAKE_CLI_UPDATE_FAIL'
] as const;

function resetUpdateEnv(): void {
  for (const key of UPDATE_ENV_KEYS) delete process.env[key];
}

interface RunPayload {
  runId: string;
  operationId: string;
  state: string;
  result?: unknown;
  progress?: { currentTask?: string | null; message?: string };
  error?: { code?: string; message?: string; retryable?: boolean; details?: Record<string, unknown> };
}

interface UpdateSuccessPayload {
  runId?: string;
  state?: string;
  run?: RunPayload;
  plan?: { action?: string };
  output?: string;
  steps?: { core: { success: boolean }; resources: { success: boolean } };
  runtime?: { resource: { status: string } };
}

interface RunSnapshotPayload {
  run: RunPayload | null;
  activeRuns: RunPayload[];
  lastRun: RunPayload | null;
  occupancy: { state: string; runId: string | null; sources: string[] };
}

async function getRun(baseUrl: string, runId: string): Promise<RunPayload> {
  const body = await readSuccess<RunPayload>(await fetch(`${baseUrl}/runs/${runId}`));
  return body.data;
}

async function waitForRun(
  baseUrl: string,
  runId: string,
  predicate: (run: RunPayload) => boolean,
  timeoutMs = 15_000
): Promise<RunPayload> {
  const deadline = Date.now() + timeoutMs;
  let last: RunPayload | null = null;
  while (Date.now() < deadline) {
    last = await getRun(baseUrl, runId);
    if (predicate(last)) return last;
    await new Promise(resolve => { setTimeout(resolve, 25); });
  }
  assert.fail(`run ${runId} did not reach expected state: ${JSON.stringify(last)}`);
}

async function waitForLogLine(path: string, pattern: RegExp, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await readFile(path, 'utf-8').catch(() => '');
    if (pattern.test(content)) return;
    await new Promise(resolve => { setTimeout(resolve, 25); });
  }
  assert.fail(`${path} did not record ${pattern}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  resetUpdateEnv();
});

after(async () => {
  await closeHttpServers(servers);
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('tracked update runs', () => {
  it('records a synchronous core update as a queryable succeeded run', async () => {
    await writeFile(cliCallLog, '', 'utf-8');
    const port = await startHttpServer(createLaPlumaApp({ env: {} }), servers);
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;

    const response = await postJson(`${baseUrl}/actions/update-core`, {});
    assert.equal(response.status, 200);
    const body = await readSuccess<UpdateSuccessPayload>(response);
    assert.equal(typeof body.data.runId, 'string');
    assert.equal(body.data.state, 'succeeded');
    assert.equal(body.data.run?.operationId, 'update_core');
    assert.equal(body.data.run?.state, 'succeeded');
    assert.equal(body.data.plan?.action, 'update-core-and-resources');
    assert.equal(body.data.steps?.core.success, true);
    assert.equal(body.data.steps?.resources.success, true);
    assert.equal(body.data.runtime?.resource.status, 'current');
    assert.equal(response.headers.get('x-la-pluma-run-id'), body.data.runId);

    const run = await getRun(baseUrl, String(body.data.runId));
    assert.equal(run.operationId, 'update_core');
    assert.equal(run.state, 'succeeded');
    assert.match(JSON.stringify(run.result), /MaaCore v6\.9\.9/);

    const snapshot = await readSuccess<RunSnapshotPayload>(await fetch(`${baseUrl}/runs/current`));
    assert.equal(snapshot.data.occupancy.state, 'idle');
    assert.equal(snapshot.data.lastRun?.runId, body.data.runId);
    assert.equal(await pathExists(lockFile), false);

    // maa-cli 的 update 自带资源同步：Core 更新后不能再启动第二次 hot-update。
    const calls = await readFile(cliCallLog, 'utf-8');
    assert.match(calls, /^update$/m);
    assert.doesNotMatch(calls, /^hot-update$/m);
  });

  it('starts a core update in the background, owns occupancy, and stops by runId', async () => {
    process.env.FAKE_UPDATE_SLEEP_MS = '20000';
    const port = await startHttpServer(createLaPlumaApp({ env: {} }), servers);
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;

    const response = await postJson(`${baseUrl}/actions/update-core`, { waitForCompletion: false });
    assert.equal(response.status, 202);
    const body = await readSuccess<UpdateSuccessPayload>(response);
    assert.equal(typeof body.data.runId, 'string');
    const runId = String(body.data.runId);
    const running = await waitForRun(baseUrl, runId, run => run.state === 'running');
    assert.equal(running.operationId, 'update_core');

    // 受管子进程写入 taskStatus 后，Run 的进度投影报告当前维护任务。
    const progress = await waitForRun(
      baseUrl,
      runId,
      run => run.progress?.message === 'MaaCore 更新进行中'
    );
    assert.equal(progress.progress?.currentTask, '更新 MaaCore 与资源');

    const snapshot = await readSuccess<RunSnapshotPayload>(await fetch(`${baseUrl}/runs/current`));
    assert.equal(snapshot.data.occupancy.state, 'run');
    assert.equal(snapshot.data.occupancy.runId, runId);
    assert.deepEqual(snapshot.data.occupancy.sources.includes('run'), true);

    const stop = await postJson(`${baseUrl}/actions/stop`, { runId });
    assert.equal(stop.status, 200);
    const stoppedBody = await readSuccess<{ stopRequested: boolean; deviceStopRequested: boolean; run: RunPayload }>(stop);
    assert.equal(stoppedBody.data.stopRequested, true);
    assert.equal(stoppedBody.data.deviceStopRequested, true);

    const stopped = await waitForRun(baseUrl, runId, run => run.state === 'stopped');
    assert.equal(stopped.operationId, 'update_core');
    assert.equal(await pathExists(lockFile), false);

    // 重复停止保持成功且不改写终态。
    const repeated = await postJson(`${baseUrl}/actions/stop`, { runId });
    assert.equal(repeated.status, 200);
    const repeatedBody = await readSuccess<{ alreadyTerminal: boolean }>(repeated);
    assert.equal(repeatedBody.data.alreadyTerminal, true);
  });

  const updateFailureCases = [
    {
      name: 'core update',
      envKey: 'FAKE_UPDATE_FAIL',
      path: '/actions/update-core',
      body: { version: 'beta' },
      code: 'AGENT_MAA_UPDATE_CORE_FAILED',
      operationId: 'update_core',
      details: { failedStep: 'core', coreUpdated: false, version: 'beta' }
    },
    {
      name: 'CLI update',
      envKey: 'FAKE_CLI_UPDATE_FAIL',
      path: '/actions/update-cli',
      body: {},
      code: 'AGENT_MAA_UPDATE_CLI_FAILED',
      operationId: 'update_cli'
    },
    {
      name: 'resource update',
      envKey: 'FAKE_HOT_UPDATE_FAIL',
      path: '/actions/hot-update-resources',
      body: {},
      code: 'AGENT_MAA_RESOURCE_UPDATE_FAILED',
      operationId: 'update_resources'
    }
  ];

  for (const failureCase of updateFailureCases) {
    it(`normalizes ${failureCase.name} failures into failed runs with the existing error code`, async () => {
      process.env[failureCase.envKey] = '1';
      const port = await startHttpServer(createLaPlumaApp({ env: {} }), servers);
      const baseUrl = `http://127.0.0.1:${port}/api/agent`;

      const response = await postJson(`${baseUrl}${failureCase.path}`, failureCase.body);
      assert.equal(response.status, 500);
      const body = await readError(response);
      assert.equal(body.error.code, failureCase.code);
      assert.equal(body.error.retryable, true);

      const failureDetails = body.error.details as {
        runId?: unknown;
        failedStep?: unknown;
        coreUpdated?: unknown;
        version?: unknown;
      };
      if (failureCase.details) {
        assert.equal(failureDetails.failedStep, failureCase.details.failedStep);
        assert.equal(failureDetails.coreUpdated, failureCase.details.coreUpdated);
        assert.equal(failureDetails.version, failureCase.details.version);
      }

      const runId = String(failureDetails.runId);
      assert.ok(runId && runId !== 'undefined');
      const run = await getRun(baseUrl, runId);
      assert.equal(run.operationId, failureCase.operationId);
      assert.equal(run.state, 'failed');
      assert.equal(run.error?.code, failureCase.code);
      assert.equal(run.error?.retryable, true);
      assert.equal(await pathExists(lockFile), false);
    });
  }

  const backgroundStopCases = [
    {
      name: 'resource update',
      envKey: 'FAKE_HOT_UPDATE_SLEEP_MS',
      path: '/actions/hot-update-resources',
      operationId: 'update_resources',
      stopRunIdInQuery: true
    },
    {
      name: 'CLI update',
      envKey: 'FAKE_CLI_UPDATE_SLEEP_MS',
      path: '/actions/update-cli',
      operationId: 'update_cli',
      stopRunIdInQuery: false
    }
  ];

  for (const stopCase of backgroundStopCases) {
    it(`stops a background ${stopCase.name} and leaves the lease reusable`, async () => {
      process.env[stopCase.envKey] = '20000';
      const port = await startHttpServer(createLaPlumaApp({ env: {} }), servers);
      const baseUrl = `http://127.0.0.1:${port}/api/agent`;

      const response = await postJson(`${baseUrl}${stopCase.path}`, { waitForCompletion: false });
      assert.equal(response.status, 202);
      const body = await readSuccess<UpdateSuccessPayload>(response);
      const runId = String(body.data.runId);
      await waitForRun(baseUrl, runId, run => run.state === 'running');

      // 停止参数同时支持 body 与 query：两种入口都落到同一个 runId。
      const stopUrl = stopCase.stopRunIdInQuery
        ? `${baseUrl}/actions/stop?runId=${encodeURIComponent(runId)}`
        : `${baseUrl}/actions/stop`;
      const stop = await postJson(stopUrl, stopCase.stopRunIdInQuery ? {} : { runId });
      assert.equal(stop.status, 200);
      const stopped = await waitForRun(baseUrl, runId, run => run.state === 'stopped');
      assert.equal(stopped.operationId, stopCase.operationId);
      assert.equal(await pathExists(lockFile), false);

      // 后台更新被停止后租约释放，下一轮更新可以正常开始。
      delete process.env[stopCase.envKey];
      const next = await postJson(`${baseUrl}${stopCase.path}`, {});
      assert.equal(next.status, 200);
      const nextBody = await readSuccess<UpdateSuccessPayload>(next);
      assert.equal(nextBody.data.state, 'succeeded');
    });
  }

  it('rejects concurrent resource updates immediately instead of waiting for the first update', async () => {
    await writeFile(cliCallLog, '', 'utf-8');
    process.env.FAKE_HOT_UPDATE_SLEEP_MS = '20000';
    const port = await startHttpServer(createLaPlumaApp({ env: {} }), servers);
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;
    let firstRunId: string | null = null;

    try {
      const first = await postJson(`${baseUrl}/actions/hot-update-resources`, { waitForCompletion: false });
      assert.equal(first.status, 202);
      firstRunId = String((await readSuccess<UpdateSuccessPayload>(first)).data.runId);
      await waitForRun(baseUrl, firstRunId, run => run.state === 'running');
      await waitForLogLine(cliCallLog, /^hot-update$/m);

      // 同步与后台两种模式都在首个更新进行中时立即被拒绝，不等待首个结束。
      for (const body of [{}, { waitForCompletion: false }]) {
        const conflict = await postJson(`${baseUrl}/actions/hot-update-resources`, body);
        assert.equal(conflict.status, 409);
        const conflictBody = await readError(conflict);
        assert.equal(conflictBody.error.code, 'AGENT_MAA_RESOURCE_UPDATE_IN_PROGRESS');
        assert.equal(conflictBody.error.retryable, true);
        assert.match(conflictBody.message, /已有资源更新正在进行/);
        const details = conflictBody.error.details as {
          runId?: string;
          activeRunId?: string;
          activeRunState?: string;
        };
        assert.equal(details.activeRunId, firstRunId);
        assert.equal(details.activeRunState, 'running');
        assert.ok(details.runId && details.runId !== firstRunId);

        const rejectedRun = await getRun(baseUrl, String(details.runId));
        assert.equal(rejectedRun.operationId, 'update_resources');
        assert.equal(rejectedRun.state, 'failed');
        assert.equal(rejectedRun.error?.code, 'AGENT_MAA_RESOURCE_UPDATE_IN_PROGRESS');
      }

      // 冲突响应返回时首个更新仍在执行。
      const stillRunning = await getRun(baseUrl, firstRunId);
      assert.equal(stillRunning.state, 'running');
    } finally {
      delete process.env.FAKE_HOT_UPDATE_SLEEP_MS;
      if (firstRunId) {
        await postJson(`${baseUrl}/actions/stop`, { runId: firstRunId });
        await waitForRun(baseUrl, firstRunId, run => run.state === 'stopped');
      }
    }

    const calls = await readFile(cliCallLog, 'utf-8');
    assert.equal(calls.match(/^hot-update$/gm)?.length, 1, '冲突请求不能启动第二次更新');

    // 首个更新结束后，新的请求可以正常开始。
    const next = await postJson(`${baseUrl}/actions/hot-update-resources`, {});
    assert.equal(next.status, 200);
    const nextBody = await readSuccess<UpdateSuccessPayload>(next);
    assert.equal(nextBody.data.state, 'succeeded');
    const callsAfterRetry = await readFile(cliCallLog, 'utf-8');
    assert.equal(callsAfterRetry.match(/^hot-update$/gm)?.length, 2);
  });

  it('rejects concurrent updates with a failed run and releases the idempotency key', async () => {
    process.env.FAKE_UPDATE_SLEEP_MS = '20000';
    const port = await startHttpServer(createLaPlumaApp({ env: {} }), servers);
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;

    const first = await postJson(`${baseUrl}/actions/update-core`, { waitForCompletion: false });
    assert.equal(first.status, 202);
    const firstBody = await readSuccess<UpdateSuccessPayload>(first);
    const firstRunId = String(firstBody.data.runId);
    await waitForRun(baseUrl, firstRunId, run => run.state === 'running');

    const busy = await postJson(
      `${baseUrl}/actions/update-core`,
      {},
      { 'Idempotency-Key': 'update-core-busy-01' }
    );
    assert.equal(busy.status, 409);
    const busyBody = await readError(busy);
    assert.equal(busyBody.error.code, 'MAA_EXECUTION_BUSY');
    const busyRun = await getRun(
      baseUrl,
      String((busyBody.error.details as { runId?: unknown }).runId)
    );
    assert.equal(busyRun.state, 'failed');

    const stop = await postJson(`${baseUrl}/actions/stop`, { runId: firstRunId });
    assert.equal(stop.status, 200);
    await waitForRun(baseUrl, firstRunId, run => run.state === 'stopped');

    // 占用属于执行前拒绝：幂等键已释放，同键重试可以创建新 run。
    delete process.env.FAKE_UPDATE_SLEEP_MS;
    const retried = await postJson(
      `${baseUrl}/actions/update-core`,
      {},
      { 'Idempotency-Key': 'update-core-busy-01' }
    );
    assert.equal(retried.status, 200);
    const retriedBody = await readSuccess<UpdateSuccessPayload>(retried);
    assert.equal(retriedBody.data.state, 'succeeded');
    assert.notEqual(retriedBody.data.runId, busyRun.runId);
  });

  it('replays the same update run for the same idempotency key', async () => {
    await writeFile(cliCallLog, '', 'utf-8');
    const port = await startHttpServer(createLaPlumaApp({ env: {} }), servers);
    const baseUrl = `http://127.0.0.1:${port}/api/agent`;
    const headers = { 'Idempotency-Key': 'update-core-replay-01' };

    const first = await postJson(`${baseUrl}/actions/update-core`, {}, headers);
    assert.equal(first.status, 200);
    const firstBody = await readSuccess<UpdateSuccessPayload>(first);

    const replay = await postJson(`${baseUrl}/actions/update-core`, {}, headers);
    assert.equal(replay.status, 200);
    const replayBody = await readSuccess<UpdateSuccessPayload>(replay);
    assert.equal(replayBody.data.runId, firstBody.data.runId);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');

    const calls = await readFile(cliCallLog, 'utf-8');
    assert.equal(calls.match(/^update$/gm)?.length, 1);
  });
});
