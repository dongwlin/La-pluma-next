import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import type {
  CliUpdaterPlan,
  CliUpdaterResult
} from '../cliUpdaterService.ts';
import type { MaaExecutionLease } from '../executionCoordinatorService.ts';
import type { ResourceInfo } from '../resourceUpdateService.ts';
import type {
  AutoUpdateJobDependencies,
  AutoUpdateConfig
} from '../scheduleTriggerService.ts';

// 自动更新作业的默认实现会调用真实 CLI；测试只允许注入依赖，禁止触达。
process.env.MAA_CLI_PATH = '/nonexistent/maa-cli-for-auto-update-tests';
const lockDir = await mkdtemp(join(tmpdir(), 'la-pluma-auto-update-lock-'));
process.env.LA_PLUMA_MAA_LOCK_FILE = join(lockDir, 'maa-execution.lock');

const { runAutoUpdateJob } = await import('../scheduleTriggerService.ts');
const { loggerManager } = await import('../../utils/logger.ts');

const schedulerLogger = loggerManager.getLogger('Scheduler');
schedulerLogger.enableConsole = false;

after(async () => {
  delete process.env.LA_PLUMA_MAA_LOCK_FILE;
  await rm(lockDir, { recursive: true, force: true });
});

const fakeLease: MaaExecutionLease = {
  owner: {
    pid: 1,
    source: 'auto-update',
    taskName: '自动更新 MAA',
    command: 'update',
    startedAt: '2026-01-01T00:00:00.000Z'
  },
  lockPath: '/tmp/maa-execution.lock',
  reentrant: false,
  release: async () => {}
};

const plan: CliUpdaterPlan = {
  source: 'standalone',
  channel: 'stable',
  command: '/tmp/maa',
  args: ['self', 'update', 'stable'],
  supported: true
};

interface JobFixture {
  calls: string[];
  dependencies: AutoUpdateJobDependencies;
}

function createJobFixture(overrides: AutoUpdateJobDependencies = {}): JobFixture {
  const calls: string[] = [];
  const dependencies: AutoUpdateJobDependencies = {
    execUpdate: async () => {
      calls.push('core');
    },
    getResourceInfo: async (): Promise<ResourceInfo> => {
      calls.push('resource-info');
      return {
        lastUpdated: '2026-01-01T00:00:00Z',
        modifiedAt: null,
        ageDays: null,
        status: 'current',
        message: 'ok',
        activity: null,
        gacha: null
      };
    },
    readChannels: async () => ({ core: 'stable', cli: 'stable' }),
    readCapabilities: async () => ({ binary: true }),
    buildCliPlan: async (): Promise<CliUpdaterPlan> => plan,
    runCliUpdater: async (): Promise<CliUpdaterResult> => {
      calls.push('cli');
      return { stdout: '', stderr: '' };
    },
    withLease: async (_owner, run) => run(fakeLease),
    ...overrides
  };
  return { calls, dependencies };
}

function logMessages(): string[] {
  return schedulerLogger.getAllLogs().map(entry => entry.message);
}

function logEntry(message: string) {
  return schedulerLogger.getAllLogs().find(entry => entry.message === message);
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const allStepsConfig: AutoUpdateConfig = { updateCore: true, updateCli: true };

describe('scheduled auto update job', () => {
  beforeEach(() => {
    schedulerLogger.clear();
  });

  it('resolves when the core update and CLI update both succeed', async () => {
    const { calls, dependencies } = createJobFixture();

    await runAutoUpdateJob(allStepsConfig, dependencies);

    assert.deepEqual(calls, ['core', 'resource-info', 'cli']);
    assert.ok(logMessages().includes('所有自动更新任务完成'));
    assert.equal(logEntry('自动更新部分失败'), undefined);
  });

  it('rejects when the CLI update fails and never records overall success', async () => {
    const failure = new Error('self update exited with code 1');
    const { dependencies } = createJobFixture({
      runCliUpdater: async () => {
        throw failure;
      }
    });

    await assert.rejects(runAutoUpdateJob({ updateCli: true }, dependencies), error => {
      const message = errorMessageOf(error);
      assert.match(message, /MAA CLI 更新失败/);
      assert.match(message, /self update exited with code 1/);
      return true;
    });

    const partial = logEntry('自动更新部分失败');
    assert.ok(partial);
    assert.deepEqual(partial.data, { failures: ['MAA CLI 更新失败: self update exited with code 1'] });
    assert.equal(logMessages().includes('所有自动更新任务完成'), false);
    assert.equal(logEntry('MAA CLI 更新失败')?.level, 'ERROR');
  });

  it('rejects when resource info cannot be read after a core update', async () => {
    const { calls, dependencies } = createJobFixture({
      getResourceInfo: async () => {
        throw new Error('version.json unreadable');
      }
    });

    await assert.rejects(runAutoUpdateJob({ updateCore: true }, dependencies), error => {
      const message = errorMessageOf(error);
      assert.match(message, /读取 Maa 资源信息失败/);
      assert.match(message, /version.json unreadable/);
      return true;
    });

    assert.deepEqual(calls, ['core']);
    assert.equal(logMessages().includes('所有自动更新任务完成'), false);
  });

  it('rejects with the aggregated core failure even when the CLI update succeeds', async () => {
    const { calls, dependencies } = createJobFixture({
      execUpdate: async () => {
        throw new Error('hot-update failed');
      }
    });

    await assert.rejects(runAutoUpdateJob(allStepsConfig, dependencies), error => {
      const message = errorMessageOf(error);
      assert.match(message, /MaaCore 与资源更新失败/);
      assert.match(message, /hot-update failed/);
      return true;
    });

    assert.deepEqual(calls, ['cli']);
    const partial = logEntry('自动更新部分失败');
    assert.ok(partial);
    assert.deepEqual(partial.data, { failures: ['MaaCore 与资源更新失败: hot-update failed'] });
    assert.equal(logMessages().includes('所有自动更新任务完成'), false);
  });

  it('logs and rethrows lease acquisition failures', async () => {
    const busy = new Error('MAA 正在执行：领取奖励');
    const { calls, dependencies } = createJobFixture({
      withLease: async () => {
        throw busy;
      }
    });

    await assert.rejects(
      runAutoUpdateJob(allStepsConfig, dependencies),
      error => errorMessageOf(error) === 'MAA 正在执行：领取奖励'
    );

    assert.deepEqual(calls, []);
    assert.equal(logEntry('自动更新失败')?.level, 'ERROR');
    assert.equal(logMessages().includes('所有自动更新任务完成'), false);
  });
});
