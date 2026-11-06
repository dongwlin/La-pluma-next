import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import type { MaaCommandError } from '../maaProcessService.ts';

interface ExecutionOutcome {
  ok: boolean;
  result?: unknown;
  error?: MaaCommandError;
}

const root = await mkdtemp(join(tmpdir(), 'la-pluma-shutdown-maa-'));
const cliPath = join(root, 'maa');
const cacheDir = join(root, 'cache');
const lockPath = join(root, 'maa.lock');
const readyMarker = join(root, 'cli-ready');
const previousEnv: Record<string, string | undefined> = Object.fromEntries(
  ['MAA_CLI_PATH', 'MAA_CACHE_DIR', 'LA_PLUMA_MAA_LOCK_FILE', 'FIXTURE_CLI_READY'].map(key => [key, process.env[key]])
);

process.env.MAA_CLI_PATH = cliPath;
process.env.MAA_CACHE_DIR = cacheDir;
process.env.LA_PLUMA_MAA_LOCK_FILE = lockPath;
process.env.FIXTURE_CLI_READY = readyMarker;

await mkdir(cacheDir);
await writeFile(join(root, 'cli.toml'), '[resource.source]\ntype = "mirrorchyan"\n');
await writeFile(cliPath, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'dir' && args[1] === 'config') {
  process.stdout.write(${JSON.stringify(root)} + '\\n');
  process.exit(0);
}
process.stdout.write('fixture cli started: ' + args.join(' ') + '\\n');
if (args.includes('--ignore-term')) {
  process.on('SIGTERM', () => {});
} else {
  process.on('SIGTERM', () => { process.exit(143); });
}
// 就绪标记必须晚于 SIGTERM 处理器注册：父进程看到标记后可能立刻发信号，
// 标记先写会让信号落在默认处理器上，导致 SIGKILL 升级用例偶发收到 SIGTERM。
writeFileSync(process.env.FIXTURE_CLI_READY, String(process.pid));
setInterval(() => {}, 1000);
`, { mode: 0o755 });

const { execMaaCommand } = await import('../maaExecutionService.ts');
const { getTaskStatus } = await import('../maaProcessService.ts');
const {
  beginAgentRun,
  getAgentRun,
  initializeAgentRunStore,
  resetAgentRunsForTests,
  shutdownAgentRunStoreForTests,
  startAgentRun,
  stopAgentRun
} = await import('../agentRunService.ts');
const { createExecutionShutdownService } = await import('../executionShutdownService.ts');
const { clearExecutionAdmissionGateForTests } = await import('../executionAdmissionService.ts');
const { loggerManager } = await import('../../utils/logger.ts');

loggerManager.getLogger('MaaService').enableConsole = false;

const quietLogger = {
  log() {},
  info() {},
  warn() {},
  error() {}
};

let testDir = '';
let storePath = '';

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'la-pluma-shutdown-maa-store-'));
  storePath = join(testDir, 'agent-runs.json');
  try {
    await shutdownAgentRunStoreForTests();
  } catch {
    // 上一个用例的故障状态由本用例重新初始化覆盖。
  }
  resetAgentRunsForTests();
  clearExecutionAdmissionGateForTests();
  await initializeAgentRunStore({ filePath: storePath, runtimeLogger: quietLogger });
  await rm(lockPath, { force: true });
  await rm(readyMarker, { force: true });
});

afterEach(async () => {
  clearExecutionAdmissionGateForTests();
  resetAgentRunsForTests();
  await shutdownAgentRunStoreForTests().catch(() => {});
  await rm(testDir, { recursive: true, force: true });
  await rm(lockPath, { force: true });
  await rm(readyMarker, { force: true });
});

after(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

async function waitForTaskRunning() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (getTaskStatus().isRunning) return getTaskStatus();
    await new Promise<void>(resolve => { setTimeout(resolve, 10); });
  }
  throw new Error('fake CLI did not start in time');
}

// 子进程注册 SIGTERM 处理器之前收到信号会按默认行为退出；等待 CLI 自己的就绪标记。
async function waitForCliReady() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await stat(readyMarker);
      return;
    } catch {
      await new Promise<void>(resolve => { setTimeout(resolve, 10); });
    }
  }
  throw new Error('fake CLI did not announce readiness in time');
}

function beginExecution() {
  const { run } = beginAgentRun({ operationId: 'fight' });
  startAgentRun(run.runId);
  return run.runId;
}

test('shutdown terminates the running fake CLI and settles the run from its actual outcome', async () => {
  const runId = beginExecution();
  const outcomes: ExecutionOutcome[] = [];
  const execution = execMaaCommand('fight', ['1-7'], '理智作战', 'combat', true)
    .then(result => {
      outcomes.push({ ok: true, result });
    }, (error: MaaCommandError) => {
      outcomes.push({ ok: false, error });
      // 与 HTTP 执行器一致：停止后按实际结果结算 Run。
      stopAgentRun(runId, { message: error.message, signal: error.signal ?? null });
    });

  await waitForTaskRunning();
  await waitForCliReady();
  const service = createExecutionShutdownService({
    logger: quietLogger,
    settleIntervalMs: 10,
    flushReserveMs: 50,
    defaultDrainBudgetMs: 1500
  });

  const summary = await service.drain({ reason: 'SIGTERM', timeoutMs: 1500 });
  await execution;

  const settledRun = getAgentRun(runId);
  assert.ok(settledRun);
  assert.equal(settledRun.state, 'stopped');
  assert.equal(getTaskStatus().isRunning, false);
  assert.equal(outcomes.length, 1);
  const first = outcomes[0];
  assert.equal(first.ok, false);
  assert.ok(first.error);
  assert.equal(first.error.stopped, true);
  assert.ok(summary.deviceStopCalls >= 1);
  assert.deepEqual(summary.interruptedRunIds, []);
  await assert.rejects(stat(lockPath), { code: 'ENOENT' });
});

test('shutdown escalates to SIGKILL inside its budget when the fake CLI ignores SIGTERM', async () => {
  const runId = beginExecution();
  const execution = execMaaCommand('fight', ['1-7', '--ignore-term'], '理智作战', 'combat', true)
    .then((): ExecutionOutcome => ({ ok: true }), (error: MaaCommandError): ExecutionOutcome => {
      stopAgentRun(runId, { message: error.message, signal: error.signal ?? null });
      return { ok: false, error };
    });

  await waitForTaskRunning();
  await waitForCliReady();
  const service = createExecutionShutdownService({
    logger: quietLogger,
    settleIntervalMs: 10,
    flushReserveMs: 50,
    forceKillDelayMs: 200,
    defaultDrainBudgetMs: 2000
  });

  const startedAt = Date.now();
  const summary = await service.drain({ reason: 'SIGTERM', timeoutMs: 2000 });
  const outcome = await execution;

  assert.equal(outcome.ok, false);
  assert.ok(outcome.error);
  assert.equal(outcome.error.signal, 'SIGKILL');
  const settledRun = getAgentRun(runId);
  assert.ok(settledRun);
  assert.equal(settledRun.state, 'stopped');
  assert.equal(getTaskStatus().isRunning, false);
  assert.deepEqual(summary.interruptedRunIds, []);
  assert.ok(Date.now() - startedAt < 2000, 'forced shutdown should finish inside the drain budget');
  await assert.rejects(stat(lockPath), { code: 'ENOENT' });
});

test('shutdown stops a maintenance core update even without a run identity', async () => {
  // Core 更新走无任务名的 execFile 分支且没有 Run 身份：受管任务名把它登记进
  // taskStatus 后，关闭流程按同一任务进程路径识别并停止，等待实际退出后收尾。
  const outcomes: ExecutionOutcome[] = [];
  const execution = execMaaCommand('update', [], null, null, undefined, undefined, undefined, {
    execFileTimeoutMs: 60_000,
    managedTaskName: '更新 MaaCore 与资源'
  })
    .then((result): ExecutionOutcome => ({ ok: true, result }), (error: MaaCommandError): ExecutionOutcome => {
      outcomes.push({ ok: false, error });
      return { ok: false, error };
    });

  await waitForTaskRunning();
  assert.equal(getTaskStatus().taskName, '更新 MaaCore 与资源');
  await waitForCliReady();
  const service = createExecutionShutdownService({
    logger: quietLogger,
    settleIntervalMs: 10,
    flushReserveMs: 50,
    defaultDrainBudgetMs: 1500
  });

  const startedAt = Date.now();
  const summary = await service.drain({ reason: 'SIGTERM', timeoutMs: 1500 });
  const outcome = await execution;

  assert.equal(outcome.ok, false);
  assert.ok(outcome.error);
  assert.equal(getTaskStatus().isRunning, false);
  // 维护更新没有 Run 身份：不写停止意图，也不产生中断记录。
  assert.deepEqual(summary.interruptedRunIds, []);
  assert.ok(summary.deviceStopCalls >= 1);
  assert.ok(Date.now() - startedAt < 1500, 'drain should end once the maintenance child exits');
  // 执行租约在子进程退出后释放。
  await assert.rejects(stat(lockPath), { code: 'ENOENT' });
  assert.equal(outcomes.length, 1);
});
