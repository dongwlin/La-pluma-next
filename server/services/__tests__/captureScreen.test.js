import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { captureScreen } from '../maaService.js';
import { loggerManager } from '../../utils/logger.js';

const fixtureDirectories = [];
const address = 'capture-device';
const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
loggerManager.getLogger('MaaService').enableConsole = false;

async function createAdbFixture({ hang = null, connected = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'la-pluma-capture-'));
  fixtureDirectories.push(directory);
  const adbPath = join(directory, 'adb');
  const pidPath = join(directory, 'hanging.pid');
  const callsPath = join(directory, 'calls.jsonl');
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
  return { adbPath, pidPath, callsPath };
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

describe('captureScreen bounded ADB steps', () => {
  for (const connected of [true, false]) {
    it(`returns the captured image with an ${connected ? 'existing' : 'initially missing'} connection`, async () => {
      const fixture = await createAdbFixture({ connected });
      const result = await captureScreen(fixture.adbPath, address);
      assert.equal(result.image, image.toString('base64'));
      assert.ok(Number.isFinite(Date.parse(result.timestamp)));
      const calls = (await readFile(fixture.callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(calls, [
        ['devices'],
        ...connected ? [] : [['connect', address]],
        ['-s', address, 'exec-out', 'screencap', '-p']
      ]);
    });
  }

  for (const [step, timeoutMs, message] of [
    ['devices', 3000, '检查设备'],
    ['connect', 5000, '连接设备'],
    ['screencap', 8000, '读取屏幕画面']
  ]) {
    it(`terminates an unresponsive ${step} process and rejects within its deadline`, { timeout: timeoutMs + 5000 }, async () => {
      const fixture = await createAdbFixture({ hang: step, connected: step !== 'connect' });
      const startedAt = Date.now();
      await assert.rejects(captureScreen(fixture.adbPath, address), error => {
        assert.equal(error.message, `截图失败: ${message}超时（${timeoutMs}ms）`);
        assert.equal(error.cause.signal, 'SIGKILL');
        return true;
      });
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed >= timeoutMs - 100 && elapsed < timeoutMs + 3000, `unexpected ${step} timeout duration: ${elapsed}ms`);
      const pid = Number(await readFile(fixture.pidPath, 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      await rm(fixture.pidPath);
    });
  }
});
