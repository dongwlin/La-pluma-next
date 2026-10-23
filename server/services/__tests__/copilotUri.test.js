import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCopilotCommandArgs, normalizeCopilotUri, parseCopilotUri } from '../copilotUri.js';

test('parses current and legacy single and set codes', () => {
  for (const [uri, id, isSet] of [
    ['prts://1234', '1234', false],
    ['prts://s1234', '1234', true],
    ['maa://1234', '1234', false],
    ['maa://1234s', '1234', true],
    ['PRTS://S1234', '1234', true],
  ]) {
    assert.deepEqual(parseCopilotUri(uri), { id, isSet }, uri);
    assert.equal(normalizeCopilotUri(uri), `prts://${isSet ? 's' : ''}${id}`);
  }
});

test('leaves local files, flags and invalid codes unchanged', () => {
  for (const uri of ['/tmp/maa://1234', 'file:///tmp/copilot.json', '--formation', 'prts://1234s', 'prts://s', 'maa://s1234']) {
    assert.equal(parseCopilotUri(uri), null, uri);
    assert.equal(normalizeCopilotUri(uri), uri);
  }
});

test('normalizes saved legacy arguments only for copilot commands', () => {
  const args = ['maa://12', 'maa://34s', 'prts://56', '/tmp/local copilot.json', '--loop-times', '1'];
  for (const command of ['copilot', 'ssscopilot', 'paradoxcopilot']) {
    assert.deepEqual(normalizeCopilotCommandArgs(command, args), [
      'prts://12', 'prts://s34', 'prts://56', '/tmp/local copilot.json', '--loop-times', '1'
    ]);
  }
  assert.equal(args[0], 'maa://12');
  assert.equal(normalizeCopilotCommandArgs('run', args), args);
});

test('passes current URIs to the CLI even when an API client supplies legacy codes', { skip: process.platform === 'win32' }, async (t) => {
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
  const { execMaaCommand } = await import('../maaService.js');
  const result = await execMaaCommand('copilot', ['maa://12', 'maa://34s', '--loop-times', '1'], null, null, true, true);
  assert.deepEqual(JSON.parse(result.stdout), ['copilot', 'prts://12', 'prts://s34', '--loop-times', '1']);
  assert.match(result.command, /copilot prts:\/\/12 prts:\/\/s34/);
});
