import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  clearRealtimeLogs,
  DEFAULT_MAINTENANCE_EXEC_TIMEOUT_MS,
  EXEC_FILE_TIMEOUT_EXIT_GRACE_MS,
  execMaaCommandUnlocked,
  getRealtimeLogs,
  getTaskStatus,
  MAA_CLI_EXEC_TIMEOUT_MS,
  MAINTENANCE_EXEC_TIMEOUT_MS,
  MAX_CAPTURED_OUTPUT_BYTES,
  MAX_MAINTENANCE_EXEC_TIMEOUT_MS,
  resolveMaintenanceExecTimeoutMs,
  setTaskStatus,
  stopCurrentTask
} from '../maaProcessService.ts';
import type {
  MaaChildProcess,
  MaaCommandError,
  MaaCommandOutcome,
  MaaExecFileOptions,
  MaaExecFileResult,
  MaaProcessStarted,
  MaaStopResult
} from '../maaProcessService.ts';
import { createMaaLogCheckpoint, readMaaLogIncrement, readMaaLogSince } from '../maaLogFileService.ts';
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
  let maintenanceCliPath: string;

  before(async () => {
    const directory = await createTemporaryDirectory('la-pluma-maa-maintenance-');
    maintenanceCliPath = join(directory, 'maa');
    await writeFile(join(directory, 'cli.toml'), '[resource.source]\ntype = "mirrorchyan"\n');
    await writeFile(maintenanceCliPath, `#!${process.execPath}
if (process.argv[2] === 'dir' && process.argv[3] === 'config') {
  process.stdout.write(${JSON.stringify(directory)} + '\\n');
} else {
  process.exitCode = 1;
}
`, { mode: 0o755 });
  });

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
    // 端口本身不会自己结束；超时裁决先按宽限等待底层结算，再让调用方拿到拒绝。
    assert.ok(Date.now() - startedAt >= EXEC_FILE_TIMEOUT_EXIT_GRACE_MS);
    assert.ok(Date.now() - startedAt < EXEC_FILE_TIMEOUT_EXIT_GRACE_MS + 5_000);
  });

  it('keeps the managed execFile status until the underlying port settles past the timeout', async () => {
    const child = createFakeChild();
    let resolveOperation: ((result: MaaExecFileResult) => void) | null = null;
    // TS 控制流看不到 executor 内的赋值：经包装调用保留可调用性。
    const resolveNow = (result: MaaExecFileResult) => resolveOperation?.(result);
    const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
    const execution = execMaaCommandUnlocked('update', [], null, null, false, true, null, {}, {
      cliPath: maintenanceCliPath,
      execFileTimeoutMs: 50,
      managedTaskName: '更新 MaaCore 与资源',
      execFile: (_file, _args, _options, onChild) => {
        onChild?.(child);
        markStarted();
        return new Promise<MaaExecFileResult>(resolve => {
          resolveOperation = resolve;
        });
      }
    });
    await Promise.race([started, execution]);
    const startedAt = Date.now();
    assert.equal(getTaskStatus().isRunning, true);
    assert.equal(getTaskStatus().taskName, '更新 MaaCore 与资源');

    // 超时（50ms）已裁决，但底层端口 150ms 后才结算：状态与等待必须晚于结算释放。
    await new Promise<void>(resolve => { setTimeout(resolve, 150); });
    assert.ok(Date.now() - startedAt >= 150);
    assert.equal(getTaskStatus().isRunning, true, '状态不得早于底层子进程结算而释放');

    child.exitCode = 0;
    resolveNow({ stdout: 'late success', stderr: '' });
    await assert.rejects(execution, /MAA CLI 命令执行超时（50ms）/);
    assert.equal(getTaskStatus().isRunning, false);
  });

  it('registers a managed execFile child for maintenance commands and clears it after exit', async () => {
    const child = createFakeChild();
    let rejectOperation: ((error: Error) => void) | null = null;
    // TS 控制流看不到 executor 内的赋值：经包装调用保留可调用性。
    const rejectNow = (error: Error) => rejectOperation?.(error);
    clearRealtimeLogs();
    const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
    const execution = execMaaCommandUnlocked('update', [], null, null, false, true, null, {}, {
      cliPath: maintenanceCliPath,
      execFileTimeoutMs: 60_000,
      managedTaskName: '更新 MaaCore 与资源',
      execFile: (_file, _args, _options, onChild) => {
        onChild?.(child);
        markStarted();
        return new Promise<MaaExecFileResult>((_resolve, reject) => {
          rejectOperation = reject;
        });
      }
    });
    await Promise.race([started, execution]);

    // 维护子进程写入同一条 taskStatus 投影：停止请求与关闭流程按该状态识别。
    assert.equal(getTaskStatus().isRunning, true);
    assert.equal(getTaskStatus().taskName, '更新 MaaCore 与资源');
    assert.equal(getTaskStatus().stopRequested, false);

    const signals: Array<NodeJS.Signals | number> = [];
    const stopResult = stopCurrentTask({}, {
      platform: 'win32',
      killChild: (_target, signal) => {
        signals.push(signal);
        if (signal === 'SIGTERM') {
          // 子进程因信号终止：killed 置位后兜底 SIGKILL 不应再触发。
          child.killed = true;
          rejectNow(Object.assign(new Error(`Command failed: ${maintenanceCliPath} update`), { killed: true, signal }));
        }
      },
      setTimeout: () => ({ unref() {} })
    });
    assert.deepEqual(stopResult, { success: true, message: '已发送终止请求' });

    await assert.rejects(execution, error => {
      assert.equal((error as MaaCommandError).stopped, true);
      assert.match((error as Error).message, /任务已终止/);
      return true;
    });
    assert.deepEqual(signals, ['SIGTERM']);
    assert.equal(getTaskStatus().isRunning, false);
    assert.equal(getTaskStatus().stopRequested, false);
  });

  it('notifies onStarted only after the managed execFile child is registered', async () => {
    const child = createFakeChild();
    const started: MaaProcessStarted[] = [];
    const signals: Array<NodeJS.Signals | number> = [];
    const startedCountAtPort: number[] = [];
    let stopResult: MaaStopResult | null = null;
    let runningAtStart = false;
    let taskNameAtStart: string | null = null;
    let rejectOperation: ((error: Error) => void) | null = null;
    // TS 控制流看不到 executor 内的赋值：经包装调用保留可调用性。
    const rejectNow = (error: Error) => rejectOperation?.(error);

    const execution = execMaaCommandUnlocked('update', [], null, null, true, true, null, {
      onStarted: payload => {
        started.push(payload);
        // onStarted 必须发生在子进程登记之后：此时停止请求能看到受管投影。
        runningAtStart = getTaskStatus().isRunning;
        taskNameAtStart = getTaskStatus().taskName;
        // 模拟 spawn 后才发现 Run 已进入 stopping 的停止竞态。
        stopResult = stopCurrentTask({}, {
          platform: 'win32',
          killChild: (_target, signal) => {
            signals.push(signal);
            child.killed = true;
            rejectNow(Object.assign(new Error(`Command failed: ${maintenanceCliPath} update`), { killed: true, signal }));
          },
          setTimeout: () => ({ unref() {} })
        });
      }
    }, {
      cliPath: maintenanceCliPath,
      execFileTimeoutMs: 60_000,
      managedTaskName: '更新 MaaCore 与资源',
      execFile: (_file, _args, _options, onChild) => {
        const operation = new Promise<MaaExecFileResult>((_resolve, reject) => {
          rejectOperation = reject;
        });
        startedCountAtPort.push(started.length);
        onChild?.(child);
        return operation;
      }
    });

    const error: unknown = await execution.then(() => null, (rejection: unknown) => rejection);
    assert.ok(error instanceof Error);
    assert.equal((error as MaaCommandError).stopped, true, '停止的维护命令必须以 stopped 结束');
    assert.deepEqual(startedCountAtPort, [0], 'execFile 端口创建子进程前不能触发 onStarted');
    assert.equal(started.length, 1);
    assert.equal(started[0].childProcess, child);
    assert.equal(started[0].command.trimEnd(), `${maintenanceCliPath} update`);
    assert.equal(runningAtStart, true);
    assert.equal(taskNameAtStart, '更新 MaaCore 与资源');
    assert.deepEqual(stopResult, { success: true, message: '已发送终止请求' });
    assert.deepEqual(signals, ['SIGTERM']);
    assert.equal(getTaskStatus().isRunning, false);
    assert.equal(getTaskStatus().stopRequested, false);
  });

  it('clears the managed execFile status when the command completes without signals', async () => {
    const child = createFakeChild();
    const result = await execMaaCommandUnlocked('update', [], null, null, false, true, null, {}, {
      cliPath: maintenanceCliPath,
      execFileTimeoutMs: 60_000,
      managedTaskName: '更新 MaaCore 与资源',
      execFile: (_file, _args, _options, onChild) => {
        onChild?.(child);
        child.exitCode = 0;
        return Promise.resolve({ stdout: 'MaaCore v6.9.9', stderr: '' });
      }
    });

    assert.equal(result.stdout, 'MaaCore v6.9.9');
    assert.equal(getTaskStatus().isRunning, false);
    assert.deepEqual(child.signals, []);
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

  it('resolves the maintenance exec timeout with fallback and cap', () => {
    const name = 'LA_PLUMA_MAA_MAINTENANCE_TIMEOUT_MS';
    assert.equal(resolveMaintenanceExecTimeoutMs(undefined), DEFAULT_MAINTENANCE_EXEC_TIMEOUT_MS);
    assert.equal(resolveMaintenanceExecTimeoutMs('   '), DEFAULT_MAINTENANCE_EXEC_TIMEOUT_MS);
    assert.equal(resolveMaintenanceExecTimeoutMs('60000'), 60_000);
    // 超上限的配置收敛到上限，不允许单次更新无限等待。
    assert.equal(resolveMaintenanceExecTimeoutMs(String(MAX_MAINTENANCE_EXEC_TIMEOUT_MS * 2)), MAX_MAINTENANCE_EXEC_TIMEOUT_MS);
    // 非法值与实时日志上限一致静默回退，不阻断服务启动。
    assert.equal(resolveMaintenanceExecTimeoutMs('not-a-number'), DEFAULT_MAINTENANCE_EXEC_TIMEOUT_MS);
    assert.equal(resolveMaintenanceExecTimeoutMs('0'), DEFAULT_MAINTENANCE_EXEC_TIMEOUT_MS);
    assert.equal(resolveMaintenanceExecTimeoutMs('-5'), DEFAULT_MAINTENANCE_EXEC_TIMEOUT_MS);
    assert.equal(resolveMaintenanceExecTimeoutMs('1.5'), DEFAULT_MAINTENANCE_EXEC_TIMEOUT_MS);
    assert.equal(DEFAULT_MAINTENANCE_EXEC_TIMEOUT_MS, 900_000);
    assert.equal(MAX_MAINTENANCE_EXEC_TIMEOUT_MS, 3_600_000);
    assert.ok(MAINTENANCE_EXEC_TIMEOUT_MS > MAA_CLI_EXEC_TIMEOUT_MS, name);
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
    assert.ok(messages.includes('TAIL-MARKER'));
    assert.ok(!messages.some(message => message.startsWith('stdout:')));
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

  it('marks a fully read increment ok and partial increments truncated', async () => {
    const directory = await createTemporaryDirectory('la-pluma-log-increment-');
    const logPath = join(directory, 'asst.log');
    await writeFile(logPath, 'first', 'utf-8');

    const checkpoint = await createMaaLogCheckpoint({ resolveLogDir: async () => directory });
    assert.ok(checkpoint);

    assert.deepEqual(await readMaaLogIncrement(checkpoint), { status: 'ok', text: '' });

    await appendFile(logPath, 'second', 'utf-8');
    assert.deepEqual(await readMaaLogIncrement(checkpoint), { status: 'ok', text: 'second' });
    assert.deepEqual(await readMaaLogIncrement(checkpoint, 3), { status: 'truncated', text: 'ond' });

    await writeFile(logPath, 'fi', 'utf-8');
    assert.deepEqual(await readMaaLogIncrement(checkpoint), { status: 'truncated', text: '' });
  });

  it('marks a short read of the available bytes truncated', async () => {
    const handle: MaaLogFileHandle = {
      read: async (buffer, offset, length) => {
        buffer.write('del', offset, 'utf8');
        return { bytesRead: Math.min(length, 3), buffer };
      },
      close: async () => {}
    };

    const increment = await readMaaLogIncrement(
      { logPath: '/virtual/asst.log', size: 100 },
      64,
      { stat: async () => ({ size: 105 }), open: async () => handle }
    );

    assert.deepEqual(increment, { status: 'truncated', text: 'del' });
  });

  it('marks a missing checkpoint or unreadable log unreadable', async () => {
    assert.deepEqual(await readMaaLogIncrement(null), { status: 'unreadable', text: '' });

    assert.deepEqual(
      await readMaaLogIncrement(
        { logPath: '/virtual/asst.log', size: 10 },
        64,
        { stat: async () => { throw new Error('denied'); } }
      ),
      { status: 'unreadable', text: '' }
    );

    assert.deepEqual(
      await readMaaLogIncrement(
        { logPath: '/virtual/asst.log', size: 10 },
        64,
        {
          stat: async () => ({ size: 20 }),
          open: async () => { throw new Error('denied'); }
        }
      ),
      { status: 'unreadable', text: '' }
    );
  });
});
