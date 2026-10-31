import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it, mock } from 'node:test';
import { promisify } from 'node:util';
import { loggerManager } from '../../utils/logger.ts';

const testTimeoutMs = 1000;
type CommandOptions = Pick<ExecFileOptions, 'timeout' | 'killSignal'>;
const requestedOptions = new Map<string, CommandOptions[]>();
const realExecFile = promisify(childProcess.execFile);

// Keep real subprocesses and Node's timeout/kill behavior, while checking the
// production deadlines separately instead of waiting 3 + 5 + 8 seconds.
const testExecFile = Object.assign(childProcess.execFile.bind(childProcess), childProcess.execFile, {
  [promisify.custom]: (file: string, args: readonly string[], options: ExecFileOptions) => {
    requestedOptions.get(file)?.push({ timeout: options.timeout, killSignal: options.killSignal });
    return realExecFile(file, args, { ...options, timeout: testTimeoutMs });
  }
});
const execFileMock = mock.property(childProcess, 'execFile', testExecFile);
syncBuiltinESMExports();
const { captureScreen } = await import('../maaDeviceService.ts').finally(() => {
  execFileMock.mock.restore();
  syncBuiltinESMExports();
});

const fixtureDirectories: string[] = [];
const address = 'capture-device';
const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
loggerManager.getLogger('MaaService').enableConsole = false;

type AdbStep = 'devices' | 'connect' | 'screencap';

interface AdbFixture {
  adbPath: string;
  pidPath: string;
  callsPath: string;
  options: CommandOptions[];
}

async function createAdbFixture(
  { hang = null, connected = true }: { hang?: AdbStep | null; connected?: boolean } = {}
): Promise<AdbFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'la-pluma-capture-'));
  fixtureDirectories.push(directory);
  const adbPath = join(directory, 'adb');
  const pidPath = join(directory, 'hanging.pid');
  const callsPath = join(directory, 'calls.jsonl');
  const options: CommandOptions[] = [];
  requestedOptions.set(adbPath, options);
  await writeFile(adbPath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const step = args[0] === 'devices' ? 'devices' : args[0] === 'connect' ? 'connect' : 'screencap';
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
if (step === ${JSON.stringify(hang)}) {
  fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (step === 'devices') {
  process.stdout.write(${JSON.stringify(`List of devices attached\n${connected ? `${address}\tdevice\n` : ''}`)});
} else if (step === 'connect') {
  process.stdout.write('connected to ' + args[1]);
} else {
  process.stdout.write(Buffer.from(${JSON.stringify([...image])}));
}
`, { mode: 0o755 });
  return { adbPath, pidPath, callsPath, options };
}

after(async () => {
  for (const directory of fixtureDirectories) {
    try {
      const pid = Number(await readFile(join(directory, 'hanging.pid'), 'utf8'));
      process.kill(pid, 'SIGKILL');
    } catch {
      // Successful timeout assertions already observed the child exiting.
    }
    await rm(directory, { recursive: true, force: true });
  }
});

async function readAdbCalls(callsPath: string): Promise<unknown[]> {
  const content = await readFile(callsPath, 'utf8');
  return content.trim().split('\n').map(line => JSON.parse(line));
}

describe('captureScreen bounded ADB steps', () => {
  for (const connected of [true, false]) {
    it(`returns the captured image with an ${connected ? 'existing' : 'initially missing'} connection`, async () => {
      const fixture = await createAdbFixture({ connected });
      const result = await captureScreen(fixture.adbPath, address);
      assert.equal(result.image, image.toString('base64'));
      assert.ok(Number.isFinite(Date.parse(result.timestamp)));
      const calls = await readAdbCalls(fixture.callsPath);
      assert.deepEqual(calls, [
        ['devices'],
        ...connected ? [] : [['connect', address]],
        ['-s', address, 'exec-out', 'screencap', '-p']
      ]);
      assert.deepEqual(fixture.options, [3000, ...connected ? [] : [5000], 8000]
        .map(timeout => ({ timeout, killSignal: 'SIGKILL' })));
    });
  }

  for (const [step, timeoutMs, message] of [
    ['devices', 3000, '检查设备'],
    ['connect', 5000, '连接设备'],
    ['screencap', 8000, '读取屏幕画面']
  ] as const) {
    it(`terminates an unresponsive ${step} process and rejects within its deadline`, { timeout: 5000 }, async () => {
      const fixture = await createAdbFixture({ hang: step, connected: step !== 'connect' });
      const startedAt = Date.now();
      await assert.rejects(captureScreen(fixture.adbPath, address), error => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, `截图失败: ${message}超时（${timeoutMs}ms）`);
        const cause: unknown = error.cause;
        assert.ok(cause !== null && typeof cause === 'object' && 'signal' in cause);
        assert.equal(cause.signal, 'SIGKILL');
        return true;
      });
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed >= testTimeoutMs - 100 && elapsed < testTimeoutMs + 3000, `unexpected ${step} timeout duration: ${elapsed}ms`);
      assert.deepEqual(fixture.options, (step === 'devices' ? [3000] : [3000, timeoutMs])
        .map(timeout => ({ timeout, killSignal: 'SIGKILL' })));
      const pid = Number(await readFile(fixture.pidPath, 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      await rm(fixture.pidPath);
    });
  }
});
