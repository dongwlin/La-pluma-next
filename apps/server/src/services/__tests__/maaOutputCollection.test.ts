import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import {
  clearRealtimeLogs,
  execMaaCommandUnlocked,
  getRealtimeLogs,
  MAX_CAPTURED_OUTPUT_BYTES,
  MAX_REALTIME_LOG_LINE_BYTES,
  stopCurrentTask
} from '../maaProcessService.ts';
import type { MaaChildProcess, MaaCommandOutcome } from '../maaProcessService.ts';
import { loggerManager } from '../../utils/logger.ts';

loggerManager.getLogger('MaaService').enableConsole = false;

class FakeChild extends EventEmitter implements MaaChildProcess {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  kill(): boolean { return true; }
}

async function startOutputCollection(waitForCompletion: boolean) {
  clearRealtimeLogs();
  const child = new FakeChild();
  let resolveOutcome: (outcome: MaaCommandOutcome) => void = () => {};
  const settled = new Promise<MaaCommandOutcome>(resolve => { resolveOutcome = resolve; });
  const execution = execMaaCommandUnlocked(
    'version', [], '输出采集', 'diagnostics', waitForCompletion, true, null,
    { onSettled: resolveOutcome },
    { cliPath: '/virtual/maa', spawn: () => child }
  );
  // A foreground error must already have a rejection handler when the fake child fails.
  const result = execution.then(value => ({ value, error: null }), error => ({ value: null, error }));
  await new Promise<void>(resolve => setImmediate(resolve));
  return { child, settled, result };
}

for (const waitForCompletion of [false, true]) {
  describe(`${waitForCompletion ? 'foreground' : 'background'} output collection`, () => {
    it('reassembles callback JSON, UTF-8 and stderr severity across arbitrary chunks', async () => {
      const { child, settled, result } = await startOutputCollection(waitForCompletion);
      const callback = 'Assistant::append_callback | TaskChainStart {"taskchain":"Fight","message":"中文输出"}';
      const bytes = Buffer.from(`${callback}\r\n`);
      const utf8Start = bytes.indexOf(Buffer.from('中'));
      child.stdout.emit('data', bytes.subarray(0, 31));
      child.stdout.emit('data', bytes.subarray(31, utf8Start + 1));
      assert.ok(!getRealtimeLogs(500).some(entry => entry.message.startsWith('Assistant::append_callback')));
      child.stdout.emit('data', bytes.subarray(utf8Start + 1, utf8Start + 2));
      child.stdout.emit('data', bytes.subarray(utf8Start + 2));
      child.stderr.emit('data', Buffer.from('ER'));
      child.stderr.emit('data', Buffer.from('ROR 中文警告\n'));

      const records = getRealtimeLogs(500);
      assert.equal(records.filter(entry => entry.message === callback).length, 1);
      assert.equal(records.find(entry => entry.message === 'ERROR 中文警告')?.level, 'ERROR');
      assert.ok(!records.some(entry => entry.message.includes('\ufffd')));
      child.emit('close', 0, null);
      const outcome = await settled;
      assert.equal(outcome.result.stdout, callback);
      assert.equal((await result).error, null);
    });

    it('coalesces the maa-cli task report into one realtime entry', async () => {
      const { child, settled, result } = await startOutputCollection(waitForCompletion);
      child.stdout.emit('data', Buffer.from('before\nSummary\n----------------------------------------\n[Roguelike] 13:56:00 - Unfinished\nExplorations:\n'));
      child.stdout.emit('data', Buffer.from('1. Unknown;\nSummary:\nUnknown 1\nTotal gained 0 exp\n'));
      child.emit('close', 0, null);
      await settled;
      const messages = getRealtimeLogs(500).map(entry => entry.message);
      const report = messages.find(message => message.startsWith('Summary\n'));
      assert.ok(report);
      assert.equal(report.split('\n').length, 8);
      assert.ok(!messages.includes('Explorations:'));
      assert.ok(messages.includes('before'));
      assert.equal(messages.filter(message => message.includes('[Roguelike]')).length, 1);
      assert.equal((await result).error, null);
    });

    it('omits a report block whose UTF-8 bytes exceed the realtime line budget', async () => {
      const { child, settled, result } = await startOutputCollection(waitForCompletion);
      // 字符数仍低于单行上限，但 UTF-8 字节数加块头后超限：按 length 判断会漏截断。
      const payload = '中'.repeat(Math.floor(MAX_REALTIME_LOG_LINE_BYTES / 3) - 1);
      assert.ok(payload.length < MAX_REALTIME_LOG_LINE_BYTES);
      assert.ok(Buffer.byteLength(payload, 'utf8') <= MAX_REALTIME_LOG_LINE_BYTES);
      child.stdout.emit('data', Buffer.from(
        `Summary\n----------------------------------------\n${payload}\n`
      ));
      child.emit('close', 0, null);
      await settled;
      const messages = getRealtimeLogs(500).map(entry => entry.message);
      assert.ok(messages.includes('Summary: …（任务报告过长，已省略）'));
      assert.ok(!messages.some(message => message.includes(payload.slice(0, 16))));
      assert.equal((await result).error, null);
    });

    it('omits a report block accumulated past the budget across lines', async () => {
      const { child, settled, result } = await startOutputCollection(waitForCompletion);
      const chunk = '中'.repeat(8000);
      assert.ok(chunk.length * 3 < MAX_REALTIME_LOG_LINE_BYTES);
      assert.ok(Buffer.byteLength(chunk, 'utf8') * 3 > MAX_REALTIME_LOG_LINE_BYTES);
      child.stdout.emit('data', Buffer.from(
        `Summary\n----------------------------------------\n${chunk}\n${chunk}\n`
      ));
      child.stdout.emit('data', Buffer.from(`${chunk}\nreport tail\n`));
      child.emit('close', 0, null);
      await settled;
      const messages = getRealtimeLogs(500).map(entry => entry.message);
      assert.equal(messages.filter(message => message === 'Summary: …（任务报告过长，已省略）').length, 1);
      assert.ok(!messages.some(message => message.includes(chunk.slice(0, 16))));
      assert.ok(!messages.includes('report tail'));
      assert.equal((await result).error, null);
    });

    it('streams a lone Summary line when no report separator follows', async () => {
      const { child, settled, result } = await startOutputCollection(waitForCompletion);
      child.stdout.emit('data', Buffer.from('Summary\nnot a report\n'));
      child.emit('close', 0, null);
      await settled;
      const messages = getRealtimeLogs(500).map(entry => entry.message);
      assert.ok(messages.includes('Summary'));
      assert.ok(messages.includes('not a report'));
      assert.ok(!messages.some(message => message.includes('\n')));
      assert.equal((await result).error, null);
    });

    it('keeps streamed output as single lines without an aggregate duplicate', async () => {
      const { child, settled, result } = await startOutputCollection(waitForCompletion);
      child.stdout.emit('data', Buffer.from('第一行\n第二行\n'));
      child.emit('close', 0, null);
      await settled;
      const messages = getRealtimeLogs(500).map(entry => entry.message);
      assert.equal(messages.filter(message => message === '第一行').length, 1);
      assert.equal(messages.filter(message => message === '第二行').length, 1);
      assert.ok(!messages.some(message => message.startsWith('stdout:')));
      assert.equal((await result).error, null);
    });

    it('reports an intentional stop instead of a failed completion', async () => {
      const { child, settled } = await startOutputCollection(waitForCompletion);
      const stopResult = stopCurrentTask({}, {
        platform: 'win32',
        killChild: () => {},
        setTimeout: () => ({ unref() {} })
      });
      assert.equal(stopResult.success, true);
      child.emit('close', 1, null);
      const outcome = await settled;
      assert.equal(outcome.stopped, true);
      const messages = getRealtimeLogs(500).map(entry => entry.message);
      assert.ok(messages.some(message => message.startsWith('命令执行已停止:')));
      assert.ok(!messages.some(message => message.startsWith('命令执行完成:')));
      assert.ok(!messages.some(message => message.startsWith('命令执行失败:')));
    });

    it('flushes the final line once before close settlement and preserves source spacing', async () => {
      const { child, settled, result } = await startOutputCollection(waitForCompletion);
      child.stdout.emit('data', Buffer.from('  最后一行没有换行  '));
      child.stderr.emit('data', Buffer.from('WARN 最后一条警告'));
      assert.ok(!getRealtimeLogs(500).some(entry => entry.message === '  最后一行没有换行  '));
      child.emit('close', 0, null);
      const outcome = await settled;
      child.emit('close', 0, null);
      const records = getRealtimeLogs(500);
      assert.equal(records.filter(entry => entry.message === '  最后一行没有换行  ').length, 1);
      assert.equal(records.filter(entry => entry.message === 'WARN 最后一条警告').length, 1);
      assert.equal(outcome.result.stdout, '最后一行没有换行');
      assert.equal((await result).error, null);
    });

    it('keeps actual blank lines without adding an empty flush record', async () => {
      const { child, settled, result } = await startOutputCollection(waitForCompletion);
      child.stdout.emit('data', Buffer.from('\n  \n'));
      child.emit('close', 0, null);
      await settled;
      const records = getRealtimeLogs(500);
      assert.equal(records.filter(entry => entry.message === '').length, 1);
      assert.equal(records.filter(entry => entry.message === '  ').length, 1);
      assert.equal((await result).error, null);
    });

    it('flushes once on error even when close follows the error', async () => {
      const { child, settled, result } = await startOutputCollection(waitForCompletion);
      child.stdout.emit('data', Buffer.from('error path remainder'));
      child.emit('error', new Error('fake process failure'));
      const outcome = await settled;
      child.emit('close', 1, null);
      const records = getRealtimeLogs(500);
      assert.equal(records.filter(entry => entry.message === 'error path remainder').length, 1);
      assert.equal(outcome.ok, false);
      assert.ok(!records.some(entry => entry.message.startsWith('命令执行完成:')));
      await result;
    });

    it('bounds an oversized unterminated UTF-8 line and explicitly omits its payload', async () => {
      const { child, settled, result } = await startOutputCollection(waitForCompletion);
      const huge = Buffer.from(`${'中'.repeat(MAX_REALTIME_LOG_LINE_BYTES)}TAIL`);
      // Repeat a pathological stream without newlines; pending data stays bounded.
      for (let index = 0; index < 4; index += 1) child.stdout.emit('data', huge);
      child.stderr.emit('data', Buffer.from('ER'));
      child.stderr.emit('data', Buffer.concat([Buffer.from('ROR '), huge]));
      child.emit('close', 0, null);
      const outcome = await settled;
      const record = getRealtimeLogs(500).find(entry => entry.message.startsWith('…（单行输出已截断'));
      assert.ok(record);
      assert.equal(record.message, '…（单行输出已截断，内容已省略）');
      assert.ok(!record.message.includes('\ufffd'));
      assert.ok(Buffer.byteLength(record.message, 'utf8') <= MAX_REALTIME_LOG_LINE_BYTES + 100);
      assert.equal(getRealtimeLogs(500).filter(entry => entry.message.startsWith('…（单行输出已截断') && entry.level === 'ERROR').length, 1);
      assert.ok(Buffer.byteLength(outcome.result.stdout, 'utf8') <= MAX_CAPTURED_OUTPUT_BYTES);
      assert.ok(!outcome.result.stdout.includes('\ufffd'));
      assert.ok(!getRealtimeLogs(500).some(entry => entry.message.includes('\ufffd')));
      assert.equal((await result).error, null);
    });

    it('never exposes credentials when a captured line loses its prefix', async () => {
      const { child, settled, result } = await startOutputCollection(waitForCompletion);
      const longSecret = 'long-secret-value';
      // This line exceeds both budgets; neither retained tail may become a log payload.
      child.stdout.emit('data', Buffer.from(`token=${longSecret.repeat(MAX_CAPTURED_OUTPUT_BYTES)}\n`));
      child.emit('close', 0, null);
      await settled;
      const messages = getRealtimeLogs(500).map(entry => entry.message);
      assert.ok(messages.some(message => message.includes('单行输出已截断')));
      assert.ok(!messages.some(message => message.includes(longSecret)));
      assert.equal((await result).error, null);
    });

    it('logs a long source line once instead of repeating the aggregate', async () => {
      const { child, settled, result } = await startOutputCollection(waitForCompletion);
      const secret = 'aggregate-secret-value';
      const source = `token=${secret.repeat(800)}\n`;
      assert.ok(Buffer.byteLength(source) < MAX_REALTIME_LOG_LINE_BYTES);
      child.stdout.emit('data', Buffer.from(source));
      child.emit('close', 0, null);
      await settled;
      const messages = getRealtimeLogs(500).map(entry => entry.message);
      assert.ok(messages.some(message => message.includes('[REDACTED]')));
      assert.ok(!messages.some(message => message.startsWith('stdout:')));
      assert.ok(!messages.some(message => message.includes(secret)));
      assert.equal((await result).error, null);
    });
  });
}
