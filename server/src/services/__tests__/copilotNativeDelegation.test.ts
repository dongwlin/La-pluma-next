import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, beforeEach, describe } from 'node:test';
import type {
  CopilotDelegationReason,
  CopilotExecutionEntry,
  CopilotExecutionLifecycle,
  CopilotNativeDelegationInput,
  CopilotPlan,
  CopilotPlanEntry
} from '../copilotPlanService.ts';
import { loggerManager } from '../../utils/logger.ts';

// 假 CLI 同时承担 `run`（现有动态任务）与 `copilot`（原生委托）两条路径：
// 两条路径都按检查点写入同样的 `CopilotListLoadTaskFileSuccess` 事件。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-copilot-native-'));
const fakeMaaCliPath = join(fixtureDir, 'fake-maa-cli.js');
const maaCallLog = join(fixtureDir, 'maa-calls.log');
const baseResourceDir = join(fixtureDir, 'base-resource');
const maaConfigDir = join(fixtureDir, 'maa-config');
const maaLogDir = join(fixtureDir, 'maa-logs');
const maaAsstLog = join(maaLogDir, 'asst.log');
const maaCacheDir = join(fixtureDir, 'maa-cache');
const dropRecordsDir = join(fixtureDir, 'drop-records');
const progressPath = join(fixtureDir, 'copilot-progress.json');
const planDir = join(maaConfigDir, 'copilot-plans', '42');
const maaProfilePath = join(maaConfigDir, 'profiles', 'default.toml');

async function setConnectionClientType(clientType: string | null): Promise<void> {
  if (!clientType) {
    await rm(maaProfilePath, { force: true });
    return;
  }
  await mkdir(join(maaConfigDir, 'profiles'), { recursive: true });
  await writeFile(maaProfilePath, `[connection]\nclient_type = "${clientType}"\n`);
}

await mkdir(join(baseResourceDir, 'Arknights-Tile-Pos'), { recursive: true });
await mkdir(maaConfigDir, { recursive: true });
await mkdir(maaLogDir, { recursive: true });
await mkdir(maaCacheDir, { recursive: true });
await mkdir(dropRecordsDir, { recursive: true });
await writeFile(join(baseResourceDir, 'stages.json'), '[]');
for (const code of ['1-1', '1-2', '1-3']) {
  const stageId = `main_01-0${code.slice(-1)}`;
  await writeFile(
    join(baseResourceDir, 'Arknights-Tile-Pos', `${stageId}-${stageId}.json`),
    JSON.stringify({ code })
  );
}
await writeFile(maaAsstLog, '');

await writeFile(fakeMaaCliPath, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const appendCall = line => {
  if (process.env.FAKE_MAA_CALL_LOG) fs.appendFileSync(process.env.FAKE_MAA_CALL_LOG, line + '\\n');
};
const appendLoad = file => fs.appendFileSync(process.env.FAKE_MAA_LOG_FILE || '', 'Assistant::append_callback | SubTaskExtraInfo ' + JSON.stringify({
  taskchain: 'Copilot',
  details: { stage_name: 'main_01-01', file_name: file },
  what: 'CopilotListLoadTaskFileSuccess'
}) + '\\n');
const readTaskToml = () => {
  const walk = dir => {
    let files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files = files.concat(walk(full));
      else if (entry.name === 'task.toml') files.push(full);
    }
    return files;
  };
  try {
    const root = path.join(process.env.FAKE_MAA_CONFIG_DIR || '', 'tasks');
    const files = walk(root).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    return files.length ? fs.readFileSync(files[files.length - 1], 'utf8') : '';
  } catch {
    return '';
  }
};
(async () => {
  if (args[0] === 'dir' && args[1] === 'resource') {
    process.stdout.write(process.env.FAKE_MAA_RESOURCE_DIR || '');
    return 0;
  }
  if (args[0] === 'dir' && (args[1] === 'hot-update' || args[1] === 'data')) {
    process.stdout.write('');
    return 0;
  }
  if (args[0] === 'dir' && args[1] === 'config') {
    process.stdout.write(process.env.FAKE_MAA_CONFIG_DIR || '');
    return 0;
  }
  if (args[0] === 'dir' && args[1] === 'log') {
    process.stdout.write(process.env.FAKE_MAA_LOG_DIR || '');
    return 0;
  }
  if (args[0] === 'dir' && args[1] === 'cache') {
    process.stdout.write(process.env.MAA_CACHE_DIR || '');
    return 0;
  }
  if (args[0] === 'copilot') {
    appendCall('copilot ' + args.slice(1).join(' '));
    if (process.env.FAKE_NATIVE_LOG_UNREADABLE) {
      fs.rmSync(process.env.FAKE_MAA_LOG_FILE || '', { force: true });
      fs.mkdirSync(process.env.FAKE_MAA_LOG_FILE || '');
    }
    if (process.env.FAKE_NATIVE_TRUNCATE_LOG) {
      fs.writeFileSync(process.env.FAKE_MAA_LOG_FILE || '', '');
    }
    if (process.env.FAKE_NATIVE_ROTATE_LOG) {
      const logFile = process.env.FAKE_MAA_LOG_FILE || '';
      fs.renameSync(logFile, logFile + '.1');
      fs.writeFileSync(logFile, 'x'.repeat(Number(process.env.FAKE_NATIVE_ROTATE_SIZE || 4096)));
    }
    const copilotCacheDir = path.join(process.env.MAA_CACHE_DIR || '', 'copilot');
    for (const uri of args.slice(1)) {
      const id = /^prts:\\/\\/(\\d+)$/.exec(uri)?.[1];
      if (!id) continue;
      const cachedFile = path.join(copilotCacheDir, id + '.json');
      if (fs.existsSync(cachedFile)) {
        if (process.env.FAKE_NATIVE_LOG_CACHE) appendCall('cache-hit ' + id);
        continue;
      }
      if (process.env.FAKE_NATIVE_LOG_CACHE) appendCall('cache-miss ' + id);
      fs.mkdirSync(copilotCacheDir, { recursive: true });
      fs.writeFileSync(cachedFile, JSON.stringify({ stage_name: 'main_01-01', fresh: true }));
    }
    for (const step of JSON.parse(process.env.FAKE_NATIVE_LOADS || '[]')) {
      if (step.after) await sleep(step.after);
      appendLoad(path.join(process.env.MAA_CACHE_DIR || '', 'copilot', String(step.id) + '.json'));
    }
    if (process.env.FAKE_NATIVE_EXIT_DELAY) await sleep(Number(process.env.FAKE_NATIVE_EXIT_DELAY));
    return Number(process.env.FAKE_NATIVE_EXIT_CODE || 0);
  }
  if (args[0] === 'run') {
    appendCall('run ' + args.slice(1).join(' '));
    appendCall('toml ' + JSON.stringify(readTaskToml()));
    for (const step of JSON.parse(process.env.FAKE_RUN_LOADS || '[]')) {
      if (step.after) await sleep(step.after);
      appendLoad(step.file);
    }
    if (process.env.FAKE_RUN_EXIT_DELAY) await sleep(Number(process.env.FAKE_RUN_EXIT_DELAY));
    return Number(process.env.FAKE_RUN_EXIT_CODE || 0);
  }
  return 1;
})().then(
  code => process.exit(code),
  () => process.exit(1)
);
`, { mode: 0o755 });

delete process.env.MAA_CLIENT_TYPE;
process.env.MAA_CLI_PATH = fakeMaaCliPath;
process.env.FAKE_MAA_CALL_LOG = maaCallLog;
process.env.FAKE_MAA_RESOURCE_DIR = baseResourceDir;
process.env.FAKE_MAA_CONFIG_DIR = maaConfigDir;
process.env.FAKE_MAA_LOG_DIR = maaLogDir;
process.env.FAKE_MAA_LOG_FILE = maaAsstLog;
process.env.MAA_CACHE_DIR = maaCacheDir;
process.env.LA_PLUMA_COPILOT_PROGRESS_STORE = progressPath;
process.env.LA_PLUMA_MAA_LOCK_FILE = join(fixtureDir, 'maa-execution.lock');
process.env.LA_PLUMA_DROP_RECORDS_DIR = dropRecordsDir;
process.env.LA_PLUMA_AGENT_RUN_STORE = join(fixtureDir, 'agent-runs.json');

const {
  evaluateCopilotNativeDelegation,
  executeCopilotEntries,
  resetCopilotPlanCachesForTests,
  setCopilotFileLoadPollIntervalForTests
} = await import('../copilotPlanService.ts');
const {
  configureCopilotSetRuntimeForTests,
  continueManualCopilotSet,
  resetCopilotSetRunStateForTests,
  runContinuousCopilotSet,
  startManualCopilotSet
} = await import('../copilotSetRunService.ts');
const { beginAgentRun, resetAgentRunsForTests } = await import('../agentRunService.ts');

setCopilotFileLoadPollIntervalForTests(40);

const NATIVE_DELEGATION_ENV = 'LA_PLUMA_COPILOT_NATIVE_DELEGATION';

function setNativeDelegationEnabled(enabled: boolean): void {
  if (enabled) process.env[NATIVE_DELEGATION_ENV] = '1';
  else delete process.env[NATIVE_DELEGATION_ENV];
}

const originalFetch = globalThis.fetch;

function stubCopilotSite(): void {
  globalThis.fetch = async () => new Response(JSON.stringify({
    status_code: 200,
    data: {
      content: JSON.stringify({
        stage_name: 'main_01-01',
        doc: { title: '1-1' },
        opers: [{ name: 'A' }],
        groups: []
      })
    }
  }), { status: 200 });
}

beforeEach(async () => {
  resetCopilotPlanCachesForTests();
  resetCopilotSetRunStateForTests();
  resetAgentRunsForTests();
  configureCopilotSetRuntimeForTests();
  setCopilotFileLoadPollIntervalForTests(40);
  stubCopilotSite();
  process.env.FAKE_MAA_RESOURCE_DIR = baseResourceDir;
  delete process.env[NATIVE_DELEGATION_ENV];
  delete process.env.FAKE_NATIVE_LOADS;
  delete process.env.FAKE_NATIVE_EXIT_CODE;
  delete process.env.FAKE_NATIVE_EXIT_DELAY;
  delete process.env.FAKE_NATIVE_LOG_CACHE;
  delete process.env.FAKE_RUN_LOADS;
  delete process.env.FAKE_RUN_EXIT_CODE;
  delete process.env.FAKE_RUN_EXIT_DELAY;
  delete process.env.FAKE_NATIVE_LOG_UNREADABLE;
  delete process.env.FAKE_NATIVE_TRUNCATE_LOG;
  delete process.env.FAKE_NATIVE_ROTATE_LOG;
  delete process.env.FAKE_NATIVE_ROTATE_SIZE;
  await writeFile(maaCallLog, '');
  await rm(maaAsstLog, { recursive: true, force: true });
  await writeFile(maaAsstLog, '');
  await setConnectionClientType(null);
  await rm(progressPath, { force: true });
  await rm(planDir, { recursive: true, force: true });
  await rm(join(maaCacheDir, 'copilot'), { recursive: true, force: true });
  await rm(dropRecordsDir, { recursive: true, force: true });
  await mkdir(dropRecordsDir, { recursive: true });
  await rm(join(fixtureDir, 'maa-execution.lock'), { force: true });
});

after(async () => {
  globalThis.fetch = originalFetch;
  await rm(fixtureDir, { recursive: true, force: true });
});

interface EntrySpec {
  itemIndex: number;
  copilotId: number;
  stageCode: string;
  mode?: 'normal' | 'raid';
  presetFormation?: boolean;
}

function planEntry({ itemIndex, copilotId, stageCode, mode = 'normal', presetFormation = false }: EntrySpec): CopilotPlanEntry {
  return {
    key: `${itemIndex}:${copilotId}:${mode}`,
    itemIndex,
    copilotId,
    stageId: `main_01-0${stageCode.slice(-1)}`,
    displayStage: stageCode,
    apCost: 6,
    mode,
    presetFormation,
    completed: false
  };
}

function queueOf(count = 3): CopilotPlanEntry[] {
  return Array.from({ length: count }, (_, index) =>
    planEntry({ itemIndex: index, copilotId: 101 + index, stageCode: `1-${index + 1}` })
  );
}

async function readMaaCalls(): Promise<string[]> {
  return (await readFile(maaCallLog, 'utf8')).split('\n').filter(Boolean);
}

async function readProgress(): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(progressPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

interface DropSummary {
  stage: string;
  times: number;
  sanity: number;
  mode: string;
  source: string;
}

async function readDrops(): Promise<DropSummary[]> {
  const files = (await readdir(dropRecordsDir)).filter(name => name.endsWith('.json')).sort();
  const records: DropSummary[] = [];
  for (const file of files) {
    const parsed: unknown = JSON.parse(await readFile(join(dropRecordsDir, file), 'utf8'));
    const entries = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { records?: unknown }).records
      : null;
    for (const record of Array.isArray(entries) ? entries : []) {
      if (!record || typeof record !== 'object') continue;
      const fields = record as Record<string, unknown>;
      records.push({
        stage: String(fields.stage),
        times: Number(fields.times),
        sanity: Number(fields.sanity),
        mode: String(fields.mode),
        source: String(fields.source)
      });
    }
  }
  return records;
}

interface CapturedEvents {
  events: string[];
  lifecycle: CopilotExecutionLifecycle;
}

function captureEvents(): CapturedEvents {
  const events: string[] = [];
  const keyOf = (entry: CopilotExecutionEntry): string => (entry as CopilotPlanEntry).key;
  return {
    events,
    lifecycle: {
      onBeforeStart: () => {
        events.push('before-start');
      },
      onStarted: () => {
        events.push('started');
      },
      onEntryStarted: entry => {
        events.push(`entry-started:${keyOf(entry)}`);
      },
      onEntrySettled: (entry, status) => {
        events.push(`entry-settled:${keyOf(entry)}:${status}`);
      }
    }
  };
}

function nativeLoads(ids: readonly number[], delay = 150): string {
  return JSON.stringify(ids.map(id => ({ id, after: delay })));
}

function runLoads(files: readonly string[], delay = 150): string {
  return JSON.stringify(files.map(file => ({ file, after: delay })));
}

function planFiles(count = 3): string[] {
  return Array.from({ length: count }, (_, index) =>
    join(planDir, `${index}-${101 + index}-normal-1.json`)
  );
}

function nativeCopilotIds(call: string): number[] {
  return [...call.matchAll(/prts:\/\/(\d+)/g)].map(match => Number(match[1]));
}

function plannedCopilotIds(toml: string): number[] {
  return [...toml.matchAll(/(\d+)-(\d+)-(?:normal|raid)-(\d+)\.json/g)].map(match => Number(match[2]));
}

async function resetRunArtifacts(): Promise<void> {
  await writeFile(maaCallLog, '');
  await writeFile(maaAsstLog, '');
  await rm(progressPath, { force: true });
  await rm(planDir, { recursive: true, force: true });
  await rm(dropRecordsDir, { recursive: true, force: true });
  await mkdir(dropRecordsDir, { recursive: true });
}

describe('copilot native delegation conditions', () => {
  test('accepts a queue representable by the native copilot command', async () => {
    setNativeDelegationEnabled(true);
    assert.deepEqual(await evaluateCopilotNativeDelegation({ entries: queueOf(2) }), { eligible: true });
  });

  test('rejects queues when the connection runs a non-Official client type', async () => {
    setNativeDelegationEnabled(true);
    await setConnectionClientType('YoStarEN');

    assert.deepEqual(await evaluateCopilotNativeDelegation({ entries: queueOf(2) }), {
      eligible: false,
      reason: 'unsupported-client-type'
    });

    await setConnectionClientType(null);
    assert.deepEqual(await evaluateCopilotNativeDelegation({ entries: queueOf(2) }), { eligible: true });
  });

  test('rejects queues whose native command would change the MaaCore task params', async () => {
    setNativeDelegationEnabled(true);
    const two = queueOf(2);
    const cases: { label: string; input: CopilotNativeDelegationInput; reason: CopilotDelegationReason }[] = [
      { label: 'single-entry', input: { entries: queueOf(1) }, reason: 'single-entry' },
      { label: 'no-entries', input: { entries: [] }, reason: 'no-entries' },
      {
        label: 'preset-formation',
        input: { entries: [two[0], { ...two[1], presetFormation: true }] },
        reason: 'preset-formation'
      },
      {
        label: 'mixed-raid-mode',
        input: { entries: [two[0], { ...two[1], mode: 'raid' }] },
        reason: 'mixed-raid-mode'
      },
      { label: 'formation-disabled', input: { entries: two, options: { formationMode: 'off' } }, reason: 'formation-disabled' },
      { label: 'loop-times', input: { entries: two, options: { loopTimes: 2 } }, reason: 'loop-times' },
      {
        label: 'user-additional',
        input: { entries: two, options: { userAdditional: [{ name: '银灰' }] } },
        reason: 'user-additional'
      },
      {
        label: 'duplicate-copilot',
        input: { entries: [two[0], { ...two[1], copilotId: two[0].copilotId }] },
        reason: 'duplicate-copilot'
      },
      {
        label: 'unsupported-options',
        input: { entries: two, options: { formationIndex: 'abc' } },
        reason: 'unsupported-options'
      },
      {
        label: 'stage-name-mismatch',
        input: { entries: [two[0], { ...two[1], displayStage: '1-9' }] },
        reason: 'stage-name-mismatch'
      },
      {
        label: 'missing-stage-code',
        input: { entries: [two[0], { ...two[1], stageId: 'act21mini_04' }] },
        reason: 'stage-name-mismatch'
      }
    ];
    for (const { label, input, reason } of cases) {
      assert.deepEqual(await evaluateCopilotNativeDelegation(input), { eligible: false, reason }, label);
    }
  });

  test('defaults to the existing flow while the switch is unset', async () => {
    delete process.env[NATIVE_DELEGATION_ENV];
    assert.deepEqual(await evaluateCopilotNativeDelegation({ entries: queueOf(2) }), {
      eligible: false,
      reason: 'disabled'
    });
  });

  test('accepts the documented enable values regardless of case and surrounding spaces', async () => {
    for (const value of ['1', 'true', 'TRUE', ' on ', 'Yes', 'enable', 'ENABLED\t']) {
      process.env[NATIVE_DELEGATION_ENV] = value;
      assert.deepEqual(
        await evaluateCopilotNativeDelegation({ entries: queueOf(2) }),
        { eligible: true },
        JSON.stringify(value)
      );
    }
  });

  test('keeps the existing flow for explicit disable values', async () => {
    for (const value of ['0', 'false', 'OFF', ' no ', 'disabled']) {
      process.env[NATIVE_DELEGATION_ENV] = value;
      assert.deepEqual(
        await evaluateCopilotNativeDelegation({ entries: queueOf(2) }),
        { eligible: false, reason: 'disabled' },
        JSON.stringify(value)
      );
    }
  });

  test('keeps the existing flow for unrecognized or empty values', async () => {
    for (const value of ['2', 'y', 'enable=false', '   ']) {
      process.env[NATIVE_DELEGATION_ENV] = value;
      assert.deepEqual(
        await evaluateCopilotNativeDelegation({ entries: queueOf(2) }),
        { eligible: false, reason: 'disabled' },
        JSON.stringify(value)
      );
    }
  });

  test('logs the effective setting once on the first delegation decision', async () => {
    const copilotLogs = () => loggerManager.getAllLogs().filter(entry => entry.service === 'CopilotPlan');

    process.env[NATIVE_DELEGATION_ENV] = 'off';
    const before = copilotLogs().length;
    await evaluateCopilotNativeDelegation({ entries: queueOf(2) });
    delete process.env[NATIVE_DELEGATION_ENV];
    await evaluateCopilotNativeDelegation({ entries: queueOf(2) });
    const disabledLogs = copilotLogs().slice(before);
    assert.equal(disabledLogs.length, 1);
    assert.match(disabledLogs[0].message, /未启用/);
    assert.match(disabledLogs[0].message, /显式关闭/);

    resetCopilotPlanCachesForTests();
    process.env[NATIVE_DELEGATION_ENV] = 'true';
    const enabledBefore = copilotLogs().length;
    await evaluateCopilotNativeDelegation({ entries: queueOf(2) });
    const enabledLogs = copilotLogs().slice(enabledBefore);
    assert.equal(enabledLogs.length, 1);
    assert.match(enabledLogs[0].message, /已启用/);
  });
});

describe('copilot native delegation execution', () => {
  test('runs the existing flow and reports no delegation while the switch is unset', async () => {
    delete process.env[NATIVE_DELEGATION_ENV];
    process.env.FAKE_RUN_LOADS = runLoads(planFiles());

    const outcome = await executeCopilotEntries({ setId: '42', name: '测试作业集', entries: queueOf() });

    const calls = await readMaaCalls();
    assert.equal(calls.filter(call => call.startsWith('copilot ')).length, 0);
    assert.equal(calls.filter(call => call.startsWith('run ')).length, 1);
    assert.equal(outcome.success, true);
    assert.equal(outcome.delegation, undefined);
    assert.deepEqual(
      outcome.summary.taskResults.map(result => result.status),
      ['success', 'success', 'success']
    );
  });

  test('keeps the existing flow when the connection client type is not the native default', async () => {
    setNativeDelegationEnabled(true);
    await setConnectionClientType('YoStarEN');
    process.env.FAKE_RUN_LOADS = runLoads(planFiles());

    const outcome = await executeCopilotEntries({ setId: '42', name: '测试作业集', entries: queueOf() });

    const calls = await readMaaCalls();
    assert.equal(calls.filter(call => call.startsWith('copilot ')).length, 0);
    assert.equal(calls.filter(call => call.startsWith('run ')).length, 1);
    const tomlLine = calls.find(call => call.startsWith('toml '));
    assert.ok(tomlLine);
    const toml = JSON.parse(tomlLine.slice('toml '.length)) as string;
    assert.match(toml, /client_type = "YoStarEN"/);
    assert.equal(outcome.success, true);
    assert.equal(outcome.delegation, undefined);
    assert.deepEqual(
      outcome.summary.taskResults.map(result => result.status),
      ['success', 'success', 'success']
    );
  });

  test('runs the existing flow for explicit disable and unrecognized values', async () => {
    for (const value of ['off', 'maybe']) {
      await resetRunArtifacts();
      process.env[NATIVE_DELEGATION_ENV] = value;
      process.env.FAKE_RUN_LOADS = runLoads(planFiles());

      const outcome = await executeCopilotEntries({ setId: '42', name: '测试作业集', entries: queueOf() });

      const calls = await readMaaCalls();
      assert.equal(calls.filter(call => call.startsWith('copilot ')).length, 0, value);
      assert.equal(calls.filter(call => call.startsWith('run ')).length, 1, value);
      assert.equal(outcome.success, true, value);
      assert.equal(outcome.delegation, undefined, value);
    }
  });

  test('runs the queue as one native command in queue order', async () => {
    setNativeDelegationEnabled(true);
    process.env.FAKE_NATIVE_LOADS = nativeLoads([101, 102, 103]);
    process.env.FAKE_NATIVE_EXIT_DELAY = '200';
    const captured = captureEvents();

    const outcome = await executeCopilotEntries({
      setId: '42',
      name: '测试作业集',
      entries: queueOf(),
      options: { useSanityPotion: true, addTrust: true },
      lifecycle: captured.lifecycle
    });

    assert.deepEqual(await readMaaCalls(), [
      'copilot prts://101 prts://102 prts://103 --raid normal --formation --ignore-requirements --use-sanity-potion --add-trust --batch'
    ]);
    assert.deepEqual(outcome.delegation, {
      attempted: true,
      fallback: false,
      outcome: 'native-succeeded'
    });
    assert.equal(outcome.error, null);
    assert.deepEqual(
      outcome.summary.taskResults.map(result => result.status),
      ['success', 'success', 'success']
    );
    assert.deepEqual(outcome.completed, ['0:101:normal', '1:102:normal', '2:103:normal']);
    assert.deepEqual((await readProgress())['42'], outcome.completed);
    assert.deepEqual((await readDrops()).map(drop => drop.stage), ['1-1', '1-2', '1-3']);
  });

  test('reports per-entry progress from the same load events as the existing path', async () => {
    setNativeDelegationEnabled(true);
    process.env.FAKE_NATIVE_LOADS = nativeLoads([101, 102, 103]);
    process.env.FAKE_NATIVE_EXIT_DELAY = '320';
    const native = captureEvents();
    await executeCopilotEntries({ setId: '42', name: 'set', entries: queueOf(), lifecycle: native.lifecycle });

    const nativeProgress = native.events.filter(event => event.startsWith('entry-'));

    process.env.FAKE_NATIVE_LOADS = '';
    process.env.FAKE_RUN_LOADS = runLoads(planFiles());
    process.env.FAKE_RUN_EXIT_DELAY = '320';
    const existing = captureEvents();
    setNativeDelegationEnabled(false);
    await executeCopilotEntries({ setId: '42', name: 'set', entries: queueOf(), lifecycle: existing.lifecycle });

    assert.deepEqual(nativeProgress, existing.events.filter(event => event.startsWith('entry-')));
    assert.ok(
      nativeProgress.indexOf('entry-settled:0:101:normal:success')
        < nativeProgress.indexOf('entry-started:2:103:normal')
    );
  });

  test('falls back to the existing flow when the native command fails before any plan file loads', async () => {
    setNativeDelegationEnabled(true);
    process.env.FAKE_NATIVE_EXIT_CODE = '1';
    process.env.FAKE_RUN_LOADS = runLoads(planFiles());
    const captured = captureEvents();

    const outcome = await executeCopilotEntries({
      setId: '42',
      name: '测试作业集',
      entries: queueOf(),
      lifecycle: captured.lifecycle
    });

    const calls = await readMaaCalls();
    assert.equal(calls.filter(call => call.startsWith('copilot ')).length, 1);
    assert.equal(calls.filter(call => call.startsWith('run ')).length, 1);
    assert.equal(outcome.delegation?.attempted, true);
    assert.equal(outcome.delegation?.fallback, true);
    assert.equal(outcome.delegation?.outcome, 'fallback-succeeded');
    assert.equal(typeof outcome.delegation?.nativeError, 'string');
    assert.equal(outcome.error, null);
    assert.deepEqual(
      outcome.summary.taskResults.map(result => result.status),
      ['success', 'success', 'success']
    );
    assert.deepEqual((await readProgress())['42'], outcome.completed);
  });

  test('does not fall back once the native command loaded a plan file', async () => {
    setNativeDelegationEnabled(true);
    process.env.FAKE_NATIVE_LOADS = nativeLoads([101]);
    process.env.FAKE_NATIVE_EXIT_CODE = '1';
    process.env.FAKE_RUN_LOADS = runLoads(planFiles());

    const outcome = await executeCopilotEntries({ setId: '42', name: '测试作业集', entries: queueOf() });

    const calls = await readMaaCalls();
    assert.equal(calls.filter(call => call.startsWith('copilot ')).length, 1);
    assert.equal(calls.filter(call => call.startsWith('run ')).length, 0);
    assert.deepEqual(outcome.delegation, {
      attempted: true,
      fallback: false,
      outcome: 'native-failed'
    });
    assert.ok(outcome.error);
    assert.deepEqual(
      outcome.summary.taskResults.map(result => result.status),
      ['failed', 'failed', 'failed']
    );
    assert.deepEqual((await readProgress())['42'], []);
  });

  test('does not fall back when the incremental log was truncated', async () => {
    setNativeDelegationEnabled(true);
    process.env.FAKE_NATIVE_TRUNCATE_LOG = '1';
    process.env.FAKE_NATIVE_EXIT_CODE = '1';
    process.env.FAKE_RUN_LOADS = runLoads(planFiles());
    await writeFile(maaAsstLog, 'checkpoint-before-native');

    const outcome = await executeCopilotEntries({ setId: '42', name: '测试作业集', entries: queueOf() });

    const calls = await readMaaCalls();
    assert.equal(calls.filter(call => call.startsWith('copilot ')).length, 1);
    assert.equal(calls.filter(call => call.startsWith('run ')).length, 0);
    assert.deepEqual(outcome.delegation, {
      attempted: true,
      fallback: false,
      outcome: 'native-failed'
    });
    assert.ok(outcome.error);
    assert.deepEqual(
      outcome.summary.taskResults.map(result => result.status),
      ['failed', 'failed', 'failed']
    );
  });

  test('does not fall back when the log rotated and the new file grew past the checkpoint', async () => {
    setNativeDelegationEnabled(true);
    process.env.FAKE_NATIVE_ROTATE_LOG = '1';
    process.env.FAKE_NATIVE_ROTATE_SIZE = '4096';
    process.env.FAKE_NATIVE_EXIT_CODE = '1';
    process.env.FAKE_RUN_LOADS = runLoads(planFiles());
    await writeFile(maaAsstLog, 'checkpoint-before-native');

    const outcome = await executeCopilotEntries({ setId: '42', name: '测试作业集', entries: queueOf() });

    const calls = await readMaaCalls();
    assert.equal(calls.filter(call => call.startsWith('copilot ')).length, 1);
    assert.equal(calls.filter(call => call.startsWith('run ')).length, 0);
    assert.deepEqual(outcome.delegation, {
      attempted: true,
      fallback: false,
      outcome: 'native-failed'
    });
    assert.ok(outcome.error);
    assert.deepEqual(
      outcome.summary.taskResults.map(result => result.status),
      ['failed', 'failed', 'failed']
    );
  });

  test('does not fall back when the incremental log is unreadable', async () => {
    setNativeDelegationEnabled(true);
    process.env.FAKE_NATIVE_LOG_UNREADABLE = '1';
    process.env.FAKE_NATIVE_EXIT_CODE = '1';
    process.env.FAKE_RUN_LOADS = runLoads(planFiles());

    try {
      const outcome = await executeCopilotEntries({ setId: '42', name: '测试作业集', entries: queueOf() });

      const calls = await readMaaCalls();
      assert.equal(calls.filter(call => call.startsWith('copilot ')).length, 1);
      assert.equal(calls.filter(call => call.startsWith('run ')).length, 0);
      assert.deepEqual(outcome.delegation, {
        attempted: true,
        fallback: false,
        outcome: 'native-failed'
      });
      assert.ok(outcome.error);
    } finally {
      await rm(maaAsstLog, { recursive: true, force: true });
      await writeFile(maaAsstLog, '');
    }
  });

  test('treats a stop during the native command as stopped instead of falling back', async () => {
    setNativeDelegationEnabled(true);
    process.env.FAKE_NATIVE_EXIT_CODE = '1';
    process.env.FAKE_RUN_LOADS = runLoads(planFiles());
    let stopChecks = 0;

    const outcome = await executeCopilotEntries({
      setId: '42',
      name: '测试作业集',
      entries: queueOf(),
      lifecycle: {
        shouldStop: () => {
          stopChecks += 1;
          return stopChecks > 1;
        }
      }
    });

    assert.equal((await readMaaCalls()).filter(call => call.startsWith('run ')).length, 0);
    assert.equal(outcome.stopped, true);
    assert.deepEqual(outcome.delegation, {
      attempted: true,
      fallback: false,
      outcome: 'native-stopped'
    });
    assert.deepEqual(
      outcome.summary.taskResults.map(result => result.status),
      ['pending', 'pending', 'pending']
    );
  });

  test('distinguishes a failed fallback from a native-only failure', async () => {
    setNativeDelegationEnabled(true);
    process.env.FAKE_NATIVE_EXIT_CODE = '1';
    process.env.FAKE_RUN_EXIT_CODE = '1';
    process.env.FAKE_RUN_LOADS = '';

    const failedFallback = await executeCopilotEntries({
      setId: '42',
      name: '测试作业集',
      entries: queueOf()
    });

    assert.equal(failedFallback.success, false);
    assert.ok(failedFallback.error);
    assert.equal(failedFallback.delegation?.attempted, true);
    assert.equal(failedFallback.delegation?.fallback, true);
    assert.equal(failedFallback.delegation?.outcome, 'fallback-failed');
    assert.equal(typeof failedFallback.delegation?.nativeError, 'string');
    assert.deepEqual(
      failedFallback.summary.taskResults.map(result => result.status),
      ['failed', 'failed', 'failed']
    );

    await resetRunArtifacts();
    delete process.env.FAKE_RUN_EXIT_CODE;
    delete process.env.FAKE_RUN_LOADS;
    process.env.FAKE_NATIVE_LOADS = nativeLoads([101], 10);

    const nativeOnly = await executeCopilotEntries({
      setId: '42',
      name: '测试作业集',
      entries: queueOf()
    });

    assert.equal(nativeOnly.success, false);
    assert.equal(nativeOnly.delegation?.attempted, true);
    assert.equal(nativeOnly.delegation?.fallback, false);
    assert.equal(nativeOnly.delegation?.outcome, 'native-failed');
    assert.equal(nativeOnly.delegation?.nativeError, undefined);
    assert.notEqual(failedFallback.delegation?.outcome, nativeOnly.delegation?.outcome);
  });

  test('drops cached copilot files before delegating so the native command re-downloads them', async () => {
    setNativeDelegationEnabled(true);
    const cacheDir = join(maaCacheDir, 'copilot');
    const staleFile = join(cacheDir, '101.json');
    const unrelatedFile = join(cacheDir, '999.json');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(staleFile, JSON.stringify({ stage_name: 'main_01-09', stale: true }));
    await writeFile(unrelatedFile, JSON.stringify({ stage_name: 'main_01-09', stale: true }));
    process.env.FAKE_NATIVE_LOG_CACHE = '1';
    process.env.FAKE_NATIVE_LOADS = nativeLoads([101, 102, 103]);

    const outcome = await executeCopilotEntries({
      setId: '42',
      name: '测试作业集',
      entries: queueOf()
    });

    assert.equal(outcome.success, true);
    const cacheCalls = (await readMaaCalls()).filter(call => call.startsWith('cache-'));
    assert.deepEqual(cacheCalls, ['cache-miss 101', 'cache-miss 102', 'cache-miss 103']);
    assert.deepEqual(JSON.parse(await readFile(staleFile, 'utf8')), { stage_name: 'main_01-01', fresh: true });
    assert.deepEqual(JSON.parse(await readFile(unrelatedFile, 'utf8')), { stage_name: 'main_01-09', stale: true });
  });

  test('falls back to the existing flow when the copilot cache cannot be invalidated', async () => {
    setNativeDelegationEnabled(true);
    await writeFile(join(maaCacheDir, 'copilot'), 'not-a-directory');
    process.env.FAKE_RUN_LOADS = runLoads(planFiles());

    const outcome = await executeCopilotEntries({
      setId: '42',
      name: '测试作业集',
      entries: queueOf()
    });

    const calls = await readMaaCalls();
    assert.equal(calls.filter(call => call.startsWith('copilot ')).length, 0);
    assert.equal(calls.filter(call => call.startsWith('run ')).length, 1);
    assert.equal(outcome.success, true);
    assert.equal(outcome.delegation?.fallback, true);
    assert.equal(outcome.delegation?.outcome, 'fallback-succeeded');
    assert.equal(typeof outcome.delegation?.nativeError, 'string');
  });
});

describe('copilot native delegation equivalence', () => {
  test('stage selection and completed entries produce the same queue in both paths', async () => {
    const plan: CopilotPlan = {
      setId: '42',
      name: '测试作业集',
      items: [],
      entries: [
        planEntry({ itemIndex: 0, copilotId: 101, stageCode: '1-1' }),
        planEntry({ itemIndex: 1, copilotId: 102, stageCode: '1-2' }),
        planEntry({ itemIndex: 2, copilotId: 103, stageCode: '1-3' })
      ]
    };

    async function runScenario(
      entries: CopilotPlanEntry[],
      useNative: boolean,
      { selectedIndexes, seedProgress }: { selectedIndexes?: number[]; seedProgress?: string[] } = {}
    ) {
      await resetRunArtifacts();
      if (seedProgress) await writeFile(progressPath, JSON.stringify({ 42: seedProgress }));
      configureCopilotSetRuntimeForTests({ buildCopilotPlan: async () => ({ ...plan, entries }) });
      setNativeDelegationEnabled(useNative);
      const files = entries.filter(entry => !entry.completed).map(entry =>
        join(planDir, `${entry.itemIndex}-${entry.copilotId}-normal-1.json`)
      );
      process.env.FAKE_NATIVE_LOADS = useNative
        ? nativeLoads(entries.filter(entry => !entry.completed).map(entry => entry.copilotId))
        : '';
      process.env.FAKE_RUN_LOADS = useNative ? '' : runLoads(files);
      const run = beginAgentRun({ operationId: 'run_copilot_set', input: { setId: '42' } }).run;
      const result = await runContinuousCopilotSet({
        runId: run.runId,
        setId: '42',
        ...(selectedIndexes ? { selectedIndexes } : {})
      });
      const calls = await readMaaCalls();
      const nativeCall = calls.find(call => call.startsWith('copilot ')) || '';
      const tomlLine = calls.find(call => call.startsWith('toml ')) || '';
      return {
        result,
        nativeIds: nativeCopilotIds(nativeCall),
        existingIds: tomlLine
          ? plannedCopilotIds(JSON.parse(tomlLine.slice('toml '.length)) as string)
          : [],
        progress: await readProgress()
      };
    }

    const selectedNative = await runScenario(plan.entries, true, { selectedIndexes: [0, 2] });
    const selectedExisting = await runScenario(plan.entries, false, { selectedIndexes: [0, 2] });

    assert.deepEqual(selectedNative.nativeIds, [101, 103]);
    assert.deepEqual(selectedExisting.existingIds, [101, 103]);
    assert.equal(selectedNative.result.summary.plannedEntries, 3);
    assert.equal(selectedNative.result.summary.queuedEntries, 2);
    assert.equal(selectedNative.result.summary.successCount, 2);
    assert.deepEqual(selectedNative.result.summary.delegation, {
      attempted: true,
      fallback: false,
      outcome: 'native-succeeded'
    });
    assert.equal(selectedExisting.result.summary.delegation, undefined);
    assert.deepEqual(selectedNative.result.completed.sort(), selectedExisting.result.completed.sort());

    const completedEntries = plan.entries.map(entry => ({ ...entry, completed: entry.itemIndex === 1 }));
    const completedNative = await runScenario(completedEntries, true, { seedProgress: ['1:102:normal'] });
    const completedExisting = await runScenario(completedEntries, false, { seedProgress: ['1:102:normal'] });

    assert.deepEqual(completedNative.nativeIds, [101, 103]);
    assert.deepEqual(completedExisting.existingIds, [101, 103]);
    assert.equal(completedNative.result.summary.alreadyCompletedCount, 1);
    assert.equal(completedNative.result.summary.queuedEntries, 2);
    assert.deepEqual([...completedNative.result.completed].sort(), ['0:101:normal', '1:102:normal', '2:103:normal']);
    assert.deepEqual(completedNative.result.completed.sort(), completedExisting.result.completed.sort());
    assert.deepEqual(((completedNative.progress['42'] ?? []) as string[]).sort(), ((completedExisting.progress['42'] ?? []) as string[]).sort());
  });

  test('manual handoff never delegates and keeps the waiting run flow', async () => {
    setNativeDelegationEnabled(true);
    const plan: CopilotPlan = { setId: '42', name: '测试作业集', items: [], entries: queueOf(2) };
    configureCopilotSetRuntimeForTests({ buildCopilotPlan: async () => plan });
    process.env.FAKE_RUN_LOADS = runLoads([planFiles()[0]]);
    process.env.FAKE_RUN_EXIT_DELAY = '100';

    const run = beginAgentRun({ operationId: 'run_copilot_set', input: { setId: '42', mode: 'manual' } }).run;
    const started = await startManualCopilotSet({ runId: run.runId, setId: '42' });

    assert.ok('waitingForNext' in started);
    assert.equal(started.waitingForNext, true);
    assert.equal(started.nextEntry?.key, '1:102:normal');
    assert.equal(started.result.summary.delegation, undefined);
    assert.deepEqual((await readMaaCalls()).filter(call => call.startsWith('copilot ')), []);

    process.env.FAKE_RUN_LOADS = runLoads([planFiles()[1]]);
    const next = await continueManualCopilotSet({ runId: run.runId });

    assert.ok('waitingForNext' in next);
    assert.equal(next.waitingForNext, false);
    assert.equal(next.finished, true);
    assert.equal(next.result.summary.delegation, undefined);
    assert.deepEqual((await readMaaCalls()).filter(call => call.startsWith('copilot ')), []);
    assert.deepEqual(
      next.result.summary.taskResults.map(result => result.status),
      ['success', 'success']
    );
  });

  test('the two paths produce the same observable outcome for one queue', async () => {
    async function runOnce(useNative: boolean) {
      await writeFile(maaCallLog, '');
      await writeFile(maaAsstLog, '');
      await rm(progressPath, { force: true });
      await rm(dropRecordsDir, { recursive: true, force: true });
      await mkdir(dropRecordsDir, { recursive: true });
      setNativeDelegationEnabled(useNative);
      process.env.FAKE_NATIVE_LOADS = useNative ? nativeLoads([101, 102, 103]) : '';
      process.env.FAKE_NATIVE_EXIT_DELAY = '320';
      process.env.FAKE_RUN_LOADS = useNative ? '' : runLoads(planFiles());
      process.env.FAKE_RUN_EXIT_DELAY = '320';
      const captured = captureEvents();
      const outcome = await executeCopilotEntries({
        setId: '42',
        name: '测试作业集',
        entries: queueOf(),
        options: { ignoreRequirements: false, useSanityPotion: true, formationIndex: '2' },
        lifecycle: captured.lifecycle
      });
      return {
        events: captured.events,
        statuses: outcome.summary.taskResults.map(result => [result.key, result.status]),
        completed: [...outcome.completed].sort(),
        progress: (await readProgress())['42'],
        drops: await readDrops(),
        calls: await readMaaCalls()
      };
    }

    const native = await runOnce(true);
    const existing = await runOnce(false);

    assert.deepEqual(native.events, existing.events);
    assert.deepEqual(native.statuses, existing.statuses);
    assert.deepEqual(native.completed, existing.completed);
    assert.deepEqual(native.progress, existing.progress);
    assert.deepEqual(native.drops, existing.drops);

    const nativeCall = native.calls[0];
    assert.ok(nativeCall?.startsWith('copilot '));
    assert.equal(nativeCall.includes('--ignore-requirements'), false);
    assert.ok(nativeCall.includes('--formation-index 2'));

    const tomlLine = existing.calls.find(call => call.startsWith('toml '));
    assert.ok(tomlLine);
    const toml = JSON.parse(tomlLine.slice('toml '.length)) as string;
    assert.match(toml, /formation = true/);
    assert.match(toml, /ignore_requirements = false/);
    assert.match(toml, /use_sanity_potion = true/);
    assert.match(toml, /formation_index = 2/);
    assert.match(toml, /"nav_name_override" = "1-1"/);
  });
});
