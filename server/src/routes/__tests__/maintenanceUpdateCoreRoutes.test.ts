import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  closeHttpServers,
  postJson,
  readError,
  readSuccess,
  silenceLoggers,
  startHttpServer
} from '../../__tests__/support/httpTestHelpers.ts';

// 本文件在环境变量注入后再动态导入 app，让 maaProcessService 在模块加载时解析到 500ms 维护超时；
// 假 CLI 用 Atomics.wait 阻塞睡眠，保证 execFile 的 SIGKILL 超时语义真实触发；其对 `maa dir data`
// 固定退出 1，使资源步骤在 fixture 下必然失败、不触发真实下载。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-maintenance-update-core-'));
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');
const fakeAdbPath = join(fixtureDir, 'fake-adb.js');
const cliCallLog = join(fixtureDir, 'maa-calls.log');
const xdgDataHome = join(fixtureDir, 'xdg-data');
const xdgStateHome = join(fixtureDir, 'xdg-state');
const xdgConfigHome = join(fixtureDir, 'xdg-config');
const maaConfigDir = join(xdgConfigHome, 'maa');
const resourceDir = join(xdgDataHome, 'maa', 'resource');
const hotUpdateDir = join(xdgDataHome, 'maa', 'MaaResource');

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
  if (process.env.FAKE_MAA_VERSION_FAIL === '1') {
    process.stderr.write('version probe failed\\n');
    process.exit(3);
  }
  process.stdout.write('maa-cli v0.7.0\\nMaaCore v6.2.3\\n');
} else if (args[0] === 'install' || args[0] === 'update') {
  const sleepMs = Number(process.env.FAKE_MAA_UPDATE_SLEEP_MS || '0');
  if (sleepMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
  process.stdout.write('MaaCore v6.9.9\\n');
} else if (args[0] === 'dir' && args[1] === 'config') {
  process.stdout.write(process.env.FAKE_MAA_CONFIG_DIR || '');
} else if (args[0] === 'dir' && args[1] === 'resource') {
  process.stdout.write(process.env.FAKE_MAA_RESOURCE_DIR || '');
} else if (args[0] === 'dir' && args[1] === 'hot-update') {
  process.stdout.write(process.env.FAKE_MAA_HOT_UPDATE_DIR || '');
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
process.env.FAKE_MAA_HOT_UPDATE_DIR = hotUpdateDir;
process.env.FAKE_MAA_CONFIG_DIR = maaConfigDir;
process.env.XDG_DATA_HOME = xdgDataHome;
process.env.XDG_STATE_HOME = xdgStateHome;
process.env.XDG_CONFIG_HOME = xdgConfigHome;
process.env.LA_PLUMA_AGENT_RUN_STORE = join(fixtureDir, 'agent-runs.json');
process.env.LA_PLUMA_MAA_LOCK_FILE = join(fixtureDir, 'maa-execution.lock');
process.env.LA_PLUMA_WEBRTC_DIR = join(fixtureDir, 'webrtc');
process.env.LA_PLUMA_WEBRTC_ICE_SERVERS = '';
process.env.LA_PLUMA_COPILOT_PROGRESS_STORE = join(fixtureDir, 'copilot-progress.json');
process.env.LA_PLUMA_ACTIVITY_COPILOT_PROGRESS_STORE = join(fixtureDir, 'activity-copilot-progress.json');
process.env.LA_PLUMA_MAA_MAINTENANCE_TIMEOUT_MS = '500';

const { createLaPlumaApp } = await import('../../app.ts');

silenceLoggers(['Api', 'MaaService', 'AgentRoutes', 'ConfigStorage', 'UpdateService']);

const servers: Server[] = [];

after(async () => {
  await closeHttpServers(servers);
  await rm(fixtureDir, { recursive: true, force: true });
});

interface UpdateCoreErrorDetails {
  version?: unknown;
  failedStep?: unknown;
  coreUpdated?: unknown;
  runId?: unknown;
  runtime?: { core?: unknown; cli?: unknown };
}

interface RunDetail {
  runId: string;
  state: string;
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    details?: UpdateCoreErrorDetails;
  };
  result?: unknown;
}

async function readRun(baseUrl: string, runId: string): Promise<RunDetail> {
  const body: unknown = await (await fetch(`${baseUrl}/runs/${encodeURIComponent(runId)}`)).json();
  assert.ok(typeof body === 'object' && body !== null && (body as { success?: unknown }).success === true);
  const data = (body as { data?: unknown }).data;
  assert.ok(typeof data === 'object' && data !== null);
  return data as RunDetail;
}

interface TaskStatusEnvelope {
  data?: {
    isRunning?: unknown;
    taskName?: unknown;
  };
}

function isTaskStatusEnvelope(value: unknown): value is TaskStatusEnvelope {
  return typeof value === 'object'
    && value !== null
    && typeof (value as TaskStatusEnvelope).data === 'object';
}

describe('update-core maintenance timeout', () => {
  it('times out a core update beyond the injected maintenance timeout and releases the lease', async () => {
    // 2s 睡眠低于 15s 默认超时：若注入失效，这里会错误地等待默认时限。
    process.env.FAKE_MAA_UPDATE_SLEEP_MS = '2000';
    try {
      const port = await startHttpServer(createLaPlumaApp({ env: {} }), servers);
      const baseUrl = `http://127.0.0.1:${port}/api/agent`;

      const startedAt = Date.now();
      const response = await postJson(`${baseUrl}/actions/update-core`, {});
      const elapsed = Date.now() - startedAt;
      assert.equal(response.status, 500);
      const body = await readError(response);
      assert.equal(body.error.code, 'AGENT_MAA_UPDATE_CORE_FAILED');
      assert.match(body.message, /MAA CLI 命令执行超时（500ms）/);
      const details = body.error.details as UpdateCoreErrorDetails;
      assert.equal(details.failedStep, 'core');
      assert.equal(details.coreUpdated, false);
      assert.ok(elapsed < 5000, `core update should fail fast, took ${elapsed}ms`);

      // 租约已释放：紧随其后的更新再次走到阶段错误，而不是 409 MAA_EXECUTION_BUSY。
      const second = await postJson(`${baseUrl}/actions/update-core`, {});
      assert.equal(second.status, 500);
      const secondBody = await readError(second);
      assert.equal(secondBody.error.code, 'AGENT_MAA_UPDATE_CORE_FAILED');

      assert.match(await readFile(cliCallLog, 'utf-8'), /^update$/m);
    } finally {
      delete process.env.FAKE_MAA_UPDATE_SLEEP_MS;
    }
  });

  it('exposes the managed core update child through the task status projection', async () => {
    // 更新子进程经受管任务名登记进 taskStatus：状态查询能看到维护任务，
    // 子进程退出并释放租约后投影回到空闲——关闭流程按同一状态识别。
    process.env.FAKE_MAA_UPDATE_SLEEP_MS = '2000';
    try {
      const port = await startHttpServer(createLaPlumaApp({ env: {} }), servers);
      const baseUrl = `http://127.0.0.1:${port}/api/agent`;

      const updateRequest = postJson(`${baseUrl}/actions/update-core`, {});
      let managedSeen = false;
      for (let attempt = 0; attempt < 120 && !managedSeen; attempt += 1) {
        const statusBody: unknown = await (await fetch(`${baseUrl}/tasks/status`)).json();
        if (isTaskStatusEnvelope(statusBody) && statusBody.data?.isRunning === true) {
          assert.equal(statusBody.data.taskName, '更新 MaaCore 与资源');
          managedSeen = true;
          break;
        }
        await new Promise(resolve => { setTimeout(resolve, 25); });
      }
      assert.equal(managedSeen, true);

      const response = await updateRequest;
      assert.equal(response.status, 500);
      const body = await readError(response);
      assert.equal(body.error.code, 'AGENT_MAA_UPDATE_CORE_FAILED');

      const finalBody: unknown = await (await fetch(`${baseUrl}/tasks/status`)).json();
      assert.ok(isTaskStatusEnvelope(finalBody));
      assert.equal(finalBody.data?.isRunning, false);
    } finally {
      delete process.env.FAKE_MAA_UPDATE_SLEEP_MS;
    }
  });

  it('attributes an unconfirmed resource step to a retryable resources failure', async () => {
    // 资源目录无法解析时，`maa dir resource` 输出为空：core 已更新但资源状态无法确认，
    // 失败必须归因到 resources（coreUpdated:true），客户端才能给出重试资源同步入口。
    process.env.FAKE_MAA_RESOURCE_DIR = '';
    try {
      const port = await startHttpServer(createLaPlumaApp({ env: {} }), servers);
      const baseUrl = `http://127.0.0.1:${port}/api/agent`;

      const response = await postJson(`${baseUrl}/actions/update-core`, {});
      assert.equal(response.status, 500);
      const body = await readError(response);
      assert.equal(body.error.code, 'AGENT_MAA_UPDATE_RESOURCE_FAILED');
      assert.equal(body.error.retryable, true);
      assert.match(body.message, /MaaCore 已更新/);
      assert.match(body.message, /资源/);
      const details = body.error.details as UpdateCoreErrorDetails;
      assert.equal(details.failedStep, 'resources');
      assert.equal(details.coreUpdated, true);
      // 资源归因仍带上 core 命令成功后可用的实测版本投影。
      assert.equal(details.runtime?.core, 'v6.2.3');
      assert.equal(details.runtime?.cli, 'v0.7.0');

      const run = await readRun(baseUrl, String(details.runId));
      assert.equal(run.state, 'failed');
      assert.equal(run.error?.code, 'AGENT_MAA_UPDATE_RESOURCE_FAILED');
      assert.equal(run.error?.details?.failedStep, 'resources');
      assert.equal(run.error?.details?.coreUpdated, true);

      assert.match(await readFile(cliCallLog, 'utf-8'), /^update$/m);
    } finally {
      process.env.FAKE_MAA_RESOURCE_DIR = resourceDir;
    }
  });

  it('attributes a version refresh failure after a successful install to the runtime step', async () => {
    process.env.FAKE_MAA_VERSION_FAIL = '1';
    try {
      const port = await startHttpServer(createLaPlumaApp({ env: {} }), servers);
      const baseUrl = `http://127.0.0.1:${port}/api/agent`;

      const response = await postJson(`${baseUrl}/actions/update-core`, { version: 'beta' });
      assert.equal(response.status, 500);
      const body = await readError(response);
      assert.equal(body.error.code, 'AGENT_MAA_UPDATE_CORE_FAILED');
      assert.equal(body.error.retryable, true);
      assert.match(body.message, /MaaCore 已更新/);
      assert.match(body.message, /版本/);
      const details = body.error.details as UpdateCoreErrorDetails;
      assert.equal(details.failedStep, 'runtime');
      assert.equal(details.coreUpdated, true);
      assert.equal(details.version, 'beta');

      const run = await readRun(baseUrl, String(details.runId));
      assert.equal(run.state, 'failed');
      assert.equal(run.error?.code, 'AGENT_MAA_UPDATE_CORE_FAILED');
      assert.equal(run.error?.details?.failedStep, 'runtime');
      assert.equal(run.error?.details?.coreUpdated, true);
    } finally {
      delete process.env.FAKE_MAA_VERSION_FAIL;
    }
  });

  it('keeps a core update successful when the requested channel cannot be persisted', async () => {
    const cliConfigPath = join(maaConfigDir, 'cli.toml');
    const effectiveConfigPath = join(maaConfigDir, 'cli.json');
    await writeFile(effectiveConfigPath, '{}', 'utf-8');
    await writeFile(cliConfigPath, '[core\nchannel = ', 'utf-8');
    try {
      const port = await startHttpServer(createLaPlumaApp({ env: {} }), servers);
      const baseUrl = `http://127.0.0.1:${port}/api/agent`;

      const response = await postJson(`${baseUrl}/actions/update-core`, { version: 'beta' });
      assert.equal(response.status, 200);
      const body = await readSuccess<{
        channelPersisted?: unknown;
        steps: { resources: { success: boolean } };
        runId?: string;
      }>(response);
      assert.equal(body.data.channelPersisted, false);
      assert.equal(body.data.steps.resources.success, true);
      assert.doesNotMatch(body.message, /已切换/);
      assert.match(body.message, /未能持久化/);

      const run = await readRun(baseUrl, String(body.data.runId));
      assert.equal(run.state, 'succeeded');
      const result = run.result as { channelPersisted?: unknown } | undefined;
      assert.equal(result?.channelPersisted, false);

      // 持久化失败不写回：损坏的配置保持原样。
      assert.equal(await readFile(cliConfigPath, 'utf-8'), '[core\nchannel = ');
    } finally {
      await rm(cliConfigPath, { force: true });
      await rm(effectiveConfigPath, { force: true });
    }
  });
});
