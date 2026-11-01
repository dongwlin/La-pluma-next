import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { ApiErrorResponse } from '../../utils/apiHelper.ts';

// update-core 的非 dryRun 用例：Core 安装/更新必须走维护专用长超时，而
// version 等短命令维持 15s 默认。本文件在环境变量注入后再动态导入 app，
// 让 maaProcessService 在模块加载时解析到 500ms 的维护超时；假 CLI 用
// 运行时读取的睡眠时长区分"低于上限完成"与"超过上限超时"两条路径，睡眠
// 用 Atomics.wait 阻塞，保证 execFile 的 SIGKILL 超时语义被真实触发。
//
// 资源同步步骤经 update-maa-resources.ts 调用 `maa dir data`，假 CLI 对该
// 参数固定退出 1，因此资源步骤在 fixture 下必然失败：既不触发真实下载，
// 也顺带固定了"Core 已成功、资源失败分别报告"的分步语义。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-maintenance-update-core-'));
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');
const fakeAdbPath = join(fixtureDir, 'fake-adb.js');
const cliCallLog = join(fixtureDir, 'maa-calls.log');
const xdgDataHome = join(fixtureDir, 'xdg-data');
const xdgStateHome = join(fixtureDir, 'xdg-state');
const xdgConfigHome = join(fixtureDir, 'xdg-config');
const maaConfigDir = join(xdgConfigHome, 'maa');
const resourceDir = join(xdgDataHome, 'maa', 'resource');

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
} else if (args[0] === 'install' || args[0] === 'update') {
  const sleepMs = Number(process.env.FAKE_MAA_UPDATE_SLEEP_MS || '0');
  if (sleepMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
  process.stdout.write('MaaCore v6.9.9\\n');
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
const { loggerManager } = await import('../../utils/logger.ts');

for (const loggerName of ['Api', 'MaaService', 'AgentRoutes', 'ConfigStorage']) {
  loggerManager.getLogger(loggerName).enableConsole = false;
}

const servers: Server[] = [];

function isApiError(value: unknown): value is ApiErrorResponse {
  return typeof value === 'object'
    && value !== null
    && (value as { success?: unknown }).success === false;
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

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

after(async () => {
  for (const server of servers) server.close();
  await rm(fixtureDir, { recursive: true, force: true });
});

interface UpdateCoreErrorDetails {
  version?: unknown;
  failedStep?: unknown;
  coreUpdated?: unknown;
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
      const port = await listen(createLaPlumaApp({ env: {} }));
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

  it('completes the core step within the limit and reports resource sync failure separately', async () => {
    process.env.FAKE_MAA_UPDATE_SLEEP_MS = '50';
    try {
      const port = await listen(createLaPlumaApp({ env: {} }));
      const baseUrl = `http://127.0.0.1:${port}/api/agent`;

      const response = await postJson(`${baseUrl}/actions/update-core`, {});
      assert.equal(response.status, 500);
      const body = await readError(response);
      // Core 步骤在维护上限内完成，失败只发生在资源同步步骤。
      assert.equal(body.error.code, 'AGENT_MAA_UPDATE_RESOURCE_FAILED');
      assert.match(body.message, /MaaCore 已更新，但资源同步失败/);
      const details = body.error.details as UpdateCoreErrorDetails;
      assert.equal(details.failedStep, 'resources');
      assert.equal(details.coreUpdated, true);
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
      const port = await listen(createLaPlumaApp({ env: {} }));
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
});
