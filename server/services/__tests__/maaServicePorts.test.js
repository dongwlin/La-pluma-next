import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import * as maaServiceFacade from '../maaService.js';
import * as processService from '../maaProcessService.js';
import * as executionService from '../maaExecutionService.js';
import * as configService from '../maaConfigService.js';
import * as deviceService from '../maaDeviceService.js';
import * as logFileService from '../maaLogFileService.js';
import * as activityService from '../maaActivityService.js';
import {
  clearRealtimeLogs,
  execMaaCommandUnlocked,
  getRealtimeLogs,
  getTaskStatus,
  setTaskStatus,
  stopCurrentTask
} from '../maaProcessService.js';
import { createMaaLogCheckpoint, readMaaLogSince } from '../maaLogFileService.js';
import { loggerManager } from '../../utils/logger.ts';

loggerManager.getLogger('MaaService').enableConsole = false;

const temporaryDirectories = [];

after(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 999999;
  child.exitCode = null;
  child.killed = false;
  child.signals = [];
  child.kill = signal => {
    child.signals.push(signal);
    child.killed = true;
  };
  return child;
}

describe('MAA CLI process ports', () => {
  it('spawns through the injected port and keeps one subprocess projection', async () => {
    const child = createFakeChild();
    const spawnCalls = [];
    const started = [];
    let settledOutcome;
    const settled = new Promise(resolve => {
      settledOutcome = resolve;
    });

    clearRealtimeLogs();
    const started_result = await execMaaCommandUnlocked(
      'version',
      ['--probe'],
      '端口测试',
      'diagnostics',
      false,
      true,
      settledOutcome,
      { onStarted: payload => started.push(payload) },
      {
        cliPath: '/virtual/maa',
        spawn: (cliPath, args, options) => {
          spawnCalls.push({ cliPath, args, options });
          return child;
        }
      }
    );

    assert.equal(started_result.message, '任务已在后台启动');
    assert.deepEqual(spawnCalls.map(call => [call.cliPath, call.args]), [['/virtual/maa', ['version', '--probe']]]);
    assert.equal(started.length, 1);
    assert.equal(started[0].childProcess, child);

    // 子进程仍在运行时状态由同一条 taskStatus 回答，没有第二个可写执行状态。
    assert.equal(getTaskStatus().isRunning, true);
    assert.equal(getTaskStatus().taskName, '端口测试');
    assert.equal(maaServiceFacade.getTaskStatus, getTaskStatus);

    child.stdout.emit('data', Buffer.from('probe line\n'));
    child.stderr.emit('data', Buffer.from('WARN probe warning\n'));
    const beforeClose = getRealtimeLogs(10).map(entry => entry.message);
    assert.ok(beforeClose.includes('probe line'));
    assert.ok(beforeClose.includes('WARN probe warning'));

    child.emit('close', 0, null);
    const outcome = await settled;
    assert.equal(outcome.ok, true);
    assert.equal(outcome.stopped, false);
    assert.equal(outcome.result.stdout.trim(), 'probe line');
    assert.equal(getTaskStatus().isRunning, false);
  });

  it('escalates the injected stop port from SIGTERM to SIGKILL without a real child', () => {
    const child = createFakeChild();
    const signals = [];
    let escalation;

    setTaskStatus(true, '停止端口测试', 'diagnostics', child);
    const first = stopCurrentTask({ forceKillDelayMs: 10 }, {
      platform: 'linux',
      killProcessGroup: (pid, signal) => {
        signals.push([pid, signal]);
      },
      killChild: () => {
        throw new Error('进程组可用时不应回落到子进程 kill');
      },
      setTimeout: callback => {
        escalation = callback;
        return { unref() {} };
      }
    });

    assert.deepEqual(first, { success: true, message: '已发送终止请求' });
    assert.deepEqual(signals, [[child.pid, 'SIGTERM']]);
    assert.equal(getTaskStatus().stopRequested, true);

    // 重复停止只返回进行中，不重复发送信号。
    assert.deepEqual(stopCurrentTask(), { success: true, message: '终止请求已发送，正在等待任务退出' });
    assert.equal(signals.length, 1);

    escalation();
    assert.deepEqual(signals.at(-1), [child.pid, 'SIGKILL']);
    setTaskStatus(false);
  });

  it('skips the SIGKILL escalation once the child has exited', () => {
    const child = createFakeChild();
    const signals = [];
    let escalation;

    setTaskStatus(true, '已退出进程', 'diagnostics', child);
    stopCurrentTask({ forceKillDelayMs: 10 }, {
      platform: 'linux',
      killProcessGroup: (pid, signal) => signals.push(signal),
      setTimeout: callback => {
        escalation = callback;
        return { unref() {} };
      }
    });
    child.exitCode = 143;
    escalation();

    assert.deepEqual(signals, ['SIGTERM']);
    setTaskStatus(false);
  });
});

describe('MAA log checkpoint ports', () => {
  it('creates a checkpoint and reads only the appended bytes through injected ports', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'la-pluma-log-ports-'));
    temporaryDirectories.push(directory);
    const logPath = join(directory, 'asst.log');
    await writeFile(logPath, 'first', 'utf-8');

    const checkpoint = await createMaaLogCheckpoint({ resolveLogDir: async () => directory });
    assert.deepEqual(checkpoint, { logPath, size: 5 });

    await appendFile(logPath, 'second', 'utf-8');
    assert.equal(await readMaaLogSince(checkpoint), 'second');
    assert.equal(await readMaaLogSince(checkpoint, 3), 'ond');
    assert.equal(await readMaaLogSince(checkpoint, 0), '');
  });

  it('reads incremental bytes through injected stat and open ports', async () => {
    const reads = [];
    const handle = {
      read: async (buffer, offset, length, position) => {
        reads.push({ offset, length, position });
        buffer.write('delta', offset, 'utf8');
        return { bytesRead: length, buffer };
      },
      close: async () => {}
    };

    const text = await readMaaLogSince(
      { logPath: '/virtual/asst.log', size: 100 },
      64,
      { stat: async () => ({ size: 105 }), open: async () => handle }
    );

    assert.equal(text, 'delta');
    assert.deepEqual(reads, [{ offset: 0, length: 5, position: 100 }]);
  });

  it('returns null when the log file is absent and tolerates a shrinking file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'la-pluma-log-ports-missing-'));
    temporaryDirectories.push(directory);

    assert.equal(await createMaaLogCheckpoint({ resolveLogDir: async () => directory }), null);
    assert.equal(await readMaaLogSince({ logPath: join(directory, 'asst.log'), size: 10 }), '');
    assert.equal(await createMaaLogCheckpoint({ resolveLogDir: async () => { throw new Error('no cli'); } }), null);
  });
});

describe('maaService compatibility re-exports', () => {
  const owners = [
    [processService, [
      'MAX_REALTIME_LOG_LINES', 'getTaskStatus', 'getRealtimeLogs', 'clearRealtimeLogs',
      'getMaaExecutionDiagnostics', 'setTaskStatus', 'stopCurrentTask'
    ]],
    [executionService, ['requiresMaaExecutionLease', 'execMaaCommand', 'getMaaVersion', 'execDynamicTask']],
    [configService, [
      'getMaaConfigDir', 'validateMaaProfileName', 'parseMaaProfile',
      'mergeMaaProfileConnection', 'getConfig', 'saveConfig'
    ]],
    [deviceService, [
      'getAdbDeviceState', 'discoverAdbDevices', 'getGameClientState',
      'parseForegroundPackage', 'testAdbConnection', 'captureScreen'
    ]],
    [logFileService, [
      'MAX_LOG_FILE_LINES', 'createMaaLogCheckpoint', 'readMaaLogSince', 'getLogFiles',
      'cleanupLogs', 'isPathOutsideDir', 'readLogFile', 'getDebugScreenshots'
    ]],
    [activityService, ['getCurrentActivity', 'replaceActivityCode']]
  ];

  it('keeps every original export name pointing at its owner implementation', () => {
    const facadeNames = new Set(Object.keys(maaServiceFacade));
    const ownerNames = new Set();
    for (const [owner, names] of owners) {
      for (const name of names) {
        ownerNames.add(name);
        assert.equal(maaServiceFacade[name], owner[name], name);
      }
    }
    assert.deepEqual([...facadeNames].sort(), [...ownerNames].sort());
  });
});
