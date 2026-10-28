import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCopilotCommandArgs, normalizeCopilotUri, parseCopilotUri } from '../copilotUri.ts';

test('parses prts single and set codes', () => {
  const cases: [string, string, boolean][] = [
    ['prts://1234', '1234', false],
    ['prts://s1234', '1234', true],
    ['PRTS://S1234', '1234', true],
  ];
  for (const [uri, id, isSet] of cases) {
    assert.deepEqual(parseCopilotUri(uri), { id, isSet }, uri);
    assert.equal(normalizeCopilotUri(uri), `prts://${isSet ? 's' : ''}${id}`);
  }
});

test('leaves local files, flags and unsupported codes unchanged', () => {
  for (const uri of ['/tmp/maa://1234', 'file:///tmp/copilot.json', '--formation', 'prts://1234s', 'prts://s', 'maa://1234', 'maa://1234s', 'maa://s1234']) {
    assert.equal(parseCopilotUri(uri), null, uri);
    assert.equal(normalizeCopilotUri(uri), uri);
  }
});

test('keeps current and unsupported arguments unchanged for copilot commands', () => {
  const args = ['prts://12', 'prts://s34', 'maa://56', '/tmp/local copilot.json', '--loop-times', '1'];
  for (const command of ['copilot', 'ssscopilot', 'paradoxcopilot']) {
    assert.deepEqual(normalizeCopilotCommandArgs(command, args), args);
  }
  assert.equal(normalizeCopilotCommandArgs('run', args), args);
});

test('passes prts URIs to the CLI', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'la-pluma-copilot-uri-'));
  const executable = join(directory, 'maa');
  const previousCli = process.env.MAA_CLI_PATH;
  const previousLock = process.env.LA_PLUMA_MAA_LOCK_FILE;
  await writeFile(executable, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n');
  await chmod(executable, 0o755);
  process.env.MAA_CLI_PATH = executable;
  process.env.LA_PLUMA_MAA_LOCK_FILE = join(directory, 'execution.lock');
  t.after(async () => {
    if (previousCli === undefined) delete process.env.MAA_CLI_PATH;
    else process.env.MAA_CLI_PATH = previousCli;
    if (previousLock === undefined) delete process.env.LA_PLUMA_MAA_LOCK_FILE;
    else process.env.LA_PLUMA_MAA_LOCK_FILE = previousLock;
    await rm(directory, { recursive: true, force: true });
  });
  const { execMaaCommand } = await import('../maaExecutionService.ts');
  const result = await execMaaCommand('copilot', ['prts://12', 'prts://s34', '--loop-times', '1'], null, null, true, true);
  assert.deepEqual(JSON.parse(result.stdout), ['copilot', 'prts://12', 'prts://s34', '--loop-times', '1']);
  assert.match(result.command, /copilot prts:\/\/12 prts:\/\/s34/);
});
