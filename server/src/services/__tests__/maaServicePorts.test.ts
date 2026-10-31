import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  clearRealtimeLogs,
  execMaaCommandUnlocked,
  getRealtimeLogs,
  getTaskStatus,
  MAA_CLI_EXEC_TIMEOUT_MS,
  MAX_CAPTURED_OUTPUT_BYTES,
  setTaskStatus,
  stopCurrentTask
} from '../maaProcessService.ts';
import type {
  MaaChildProcess,
  MaaCommandError,
  MaaCommandOutcome,
  MaaExecFileOptions,
  MaaProcessStarted
} from '../maaProcessService.ts';
import { createMaaLogCheckpoint, readMaaLogSince } from '../maaLogFileService.ts';
import type { MaaLogFileHandle } from '../maaLogFileService.ts';
import { loggerManager } from '../../utils/logger.ts';

loggerManager.getLogger('MaaService').enableConsole = false;

const temporaryDirectories: string[] = [];

after(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

class FakeChild extends EventEmitter implements MaaChildProcess {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 999999;
  exitCode: number | null = null;
  killed = false;
  signals: Array<NodeJS.Signals | number> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    if (signal !== undefined) this.signals.push(signal);
    this.killed = true;
    return true;
  }
}

function createFakeChild(): FakeChild {
  return new FakeChild();
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe('MAA CLI process ports', () => {
  it('spawns through the injected port and keeps one subprocess projection', async () => {
    const child = createFakeChild();
    const spawnCalls: Array<{ cliPath: string; args: string[]; options: unknown }> = [];
    const started: MaaProcessStarted[] = [];
    let settledOutcome: (outcome: MaaCommandOutcome) => void = () => {};
    const settled = new Promise<MaaCommandOutcome>(resolve => {
      settledOutcome = resolve;
    });

    clearRealtimeLogs();
    const startedResult = await execMaaCommandUnlocked(
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
          spawnCalls.push({ cliPath, args: [...args], options });
          return child;
        }
      }
    );

    assert.equal(startedResult.message, '任务已在后台启动');
    assert.deepEqual(spawnCalls.map(call => [call.cliPath, call.args]), [['/virtual/maa', ['version', '--probe']]]);
    assert.equal(started.length, 1);
    assert.equal(started[0].childProcess, child);

    // 子进程仍在运行时状态由同一条 taskStatus 回答，没有第二个可写执行状态。
    assert.equal(getTaskStatus().isRunning, true);
    assert.equal(getTaskStatus().taskName, '端口测试');

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
    const signals: Array<[number, NodeJS.Signals]> = [];
    const escalationGate: { timer: (() => void) | null } = { timer: null };

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
        escalationGate.timer = callback;
        return { unref() {} };
      }
    });

    assert.deepEqual(first, { success: true, message: '已发送终止请求' });
    assert.deepEqual(signals, [[child.pid, 'SIGTERM']]);
    assert.equal(getTaskStatus().stopRequested, true);

    // 重复停止只返回进行中，不重复发送信号。
    assert.deepEqual(stopCurrentTask(), { success: true, message: '终止请求已发送，正在等待任务退出' });
    assert.equal(signals.length, 1);

    const escalation = escalationGate.timer;
    assert.ok(escalation);
    escalation();
    assert.deepEqual(signals.at(-1), [child.pid, 'SIGKILL']);
    setTaskStatus(false);
  });

  it('skips the SIGKILL escalation once the child has exited', () => {
    const child = createFakeChild();
    const signals: string[] = [];
    const escalationGate: { timer: (() => void) | null } = { timer: null };

    setTaskStatus(true, '已退出进程', 'diagnostics', child);
    stopCurrentTask({ forceKillDelayMs: 10 }, {
      platform: 'linux',
      killProcessGroup: (pid, signal) => signals.push(signal),
      setTimeout: callback => {
        escalationGate.timer = callback;
        return { unref() {} };
      }
    });
    child.exitCode = 143;
    const escalation = escalationGate.timer;
    assert.ok(escalation);
    escalation();

    assert.deepEqual(signals, ['SIGTERM']);
    setTaskStatus(false);
  });

  it('falls back to child kill on win32 instead of the process group', () => {
    const child = createFakeChild();
    const signals: string[] = [];

    setTaskStatus(true, 'Windows 停止', 'diagnostics', child);
    const result = stopCurrentTask({ forceKillDelayMs: 10 }, {
      platform: 'win32',
      killProcessGroup: () => {
        throw new Error('win32 不应按进程组发送信号');
      },
      killChild: (target, signal) => {
        signals.push(`${target.pid}:${signal}`);
      },
      setTimeout: () => ({ unref() {} })
    });

    assert.deepEqual(result, { success: true, message: '已发送终止请求' });
    assert.deepEqual(signals, [`${child.pid}:SIGTERM`]);
    setTaskStatus(false);
  });

  it('times out an injected execFile port that never settles', async () => {
    const startedAt = Date.now();
    await assert.rejects(
      execMaaCommandUnlocked('version', [], null, null, false, true, null, {}, {
        cliPath: '/virtual/maa',
        execFileTimeoutMs: 25,
        execFile: () => new Promise(() => {})
      }),
      /MAA CLI 命令执行超时/
    );
    // 端口本身不会自己结束；超时包装必须让调用方拿到拒绝并释放等待。
    assert.ok(Date.now() - startedAt < 1_000);
  });

  it('passes the exec timeout and kill signal to the execFile port', async () => {
    let resolveOptions: (options: MaaExecFileOptions) => void = () => {};
    const optionsReceived = new Promise<MaaExecFileOptions>(resolve => {
      resolveOptions = resolve;
    });
    const result = await execMaaCommandUnlocked('version', [], null, null, false, true, null, {}, {
      cliPath: '/virtual/maa',
      execFile: async (_file, _args, options) => {
        resolveOptions(options);
        return { stdout: 'ok', stderr: '' };
      }
    });

    assert.equal(result.stdout, 'ok');
    const receivedOptions = await optionsReceived;
    assert.equal(receivedOptions.timeout, MAA_CLI_EXEC_TIMEOUT_MS);
    assert.equal(receivedOptions.killSignal, 'SIGKILL');
  });

  it('treats an externally signalled background exit as a failure, not a stop', async () => {
    const child = createFakeChild();
    let resolveOutcome: (outcome: MaaCommandOutcome) => void = () => {};
    const settled = new Promise<MaaCommandOutcome>(resolve => {
      resolveOutcome = resolve;
    });

    await execMaaCommandUnlocked(
      'version', [], '外部信号', 'diagnostics', false, true, resolveOutcome, {},
      { cliPath: '/virtual/maa', spawn: () => child }
    );
    child.stdout.emit('data', Buffer.from('before crash\n'));
    child.emit('close', null, 'SIGSEGV');

    const outcome = await settled;
    assert.equal(outcome.stopped, false);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.result.exitCode, null);
    assert.equal(outcome.result.signal, 'SIGSEGV');
    assert.match(outcome.error?.message ?? '', /信号: SIGSEGV/);
  });

  it('marks a process stopped only after an explicit stop request', async () => {
    const child = createFakeChild();
    let resolveOutcome: (outcome: MaaCommandOutcome) => void = () => {};
    const settled = new Promise<MaaCommandOutcome>(resolve => {
      resolveOutcome = resolve;
    });

    await execMaaCommandUnlocked(
      'version', [], '停止判定', 'diagnostics', false, true, resolveOutcome, {},
      { cliPath: '/virtual/maa', spawn: () => child }
    );
    const stopResult = stopCurrentTask({}, {
      platform: 'win32',
      killChild: () => {},
      setTimeout: () => ({ unref() {} })
    });
    assert.equal(stopResult.success, true);

    child.emit('close', null, 'SIGTERM');
    const outcome = await settled;
    assert.equal(outcome.stopped, true);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.result.signal, 'SIGTERM');
  });

  it('keeps a bounded tail of background output and logs it in bounded entries', async () => {
    const child = createFakeChild();
    let resolveOutcome: (outcome: MaaCommandOutcome) => void = () => {};
    const settled = new Promise<MaaCommandOutcome>(resolve => {
      resolveOutcome = resolve;
    });

    clearRealtimeLogs();
    await execMaaCommandUnlocked(
      'version', [], '输出上限', 'diagnostics', false, true, resolveOutcome, {},
      { cliPath: '/virtual/maa', spawn: () => child }
    );

    const line = `${'x'.repeat(1023)}\n`;
    for (let index = 0; index < 400; index += 1) {
      child.stdout.emit('data', Buffer.from(line));
    }
    child.stdout.emit('data', Buffer.from('TAIL-MARKER\n'));
    child.emit('close', 0, null);

    const outcome = await settled;
    assert.equal(outcome.ok, true);
    assert.ok(Buffer.byteLength(outcome.result.stdout, 'utf-8') <= MAX_CAPTURED_OUTPUT_BYTES);
    assert.ok(outcome.result.stdout.endsWith('TAIL-MARKER'));

    const messages = getRealtimeLogs(5000).map(entry => entry.message);
    assert.ok(messages.some(message => message.includes('stdout:') && message.includes('TAIL-MARKER')));
    assert.ok(messages.every(message => message.length <= 9 * 1024));
  });

  it('rejects a foreground command killed by an external signal with signal metadata', async () => {
    const child = createFakeChild();
    const execution = execMaaCommandUnlocked(
      'version', [], '前台信号', 'diagnostics', true, true, null, {},
      { cliPath: '/virtual/maa', spawn: () => child }
    );

    // 端口在 prepareMaaTaskCache 之后才注册 close 监听，等一个宏任务再触发退出。
    await new Promise<void>(resolve => setImmediate(resolve));
    child.emit('close', null, 'SIGKILL');
    await assert.rejects(execution, error => {
      const commandError = error as MaaCommandError;
      assert.equal(commandError.stopped, false);
      assert.equal(commandError.exitCode, null);
      assert.equal(commandError.signal, 'SIGKILL');
      return true;
    });
  });
});

describe('MAA log checkpoint ports', () => {
  it('creates a checkpoint and reads only the appended bytes through injected ports', async () => {
    const directory = await createTemporaryDirectory('la-pluma-log-ports-');
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
    const reads: Array<{ offset: number; length: number; position: number }> = [];
    const handle: MaaLogFileHandle = {
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
    const directory = await createTemporaryDirectory('la-pluma-log-ports-missing-');

    assert.equal(await createMaaLogCheckpoint({ resolveLogDir: async () => directory }), null);
    assert.equal(await readMaaLogSince({ logPath: join(directory, 'asst.log'), size: 10 }), '');
    assert.equal(await createMaaLogCheckpoint({ resolveLogDir: async () => { throw new Error('no cli'); } }), null);
  });
});
