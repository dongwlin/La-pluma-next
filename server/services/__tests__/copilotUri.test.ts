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

test('normalizes job URIs only in copilot command arguments', () => {
  const args = ['PRTS://S34', '--loop-times', '1'];
  for (const command of ['copilot', 'ssscopilot', 'paradoxcopilot']) {
    assert.deepEqual(normalizeCopilotCommandArgs(command, args), ['prts://s34', '--loop-times', '1'], command);
  }
  assert.equal(normalizeCopilotCommandArgs('run', args), args);
});

test('passes normalized copilot URIs to the CLI', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'la-pluma-copilot-uri-'));
  const executable = join(directory, 'maa');
  const previousLock = process.env.LA_PLUMA_MAA_LOCK_FILE;
  await writeFile(executable, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n');
  await chmod(executable, 0o755);
  process.env.LA_PLUMA_MAA_LOCK_FILE = join(directory, 'execution.lock');
  t.after(async () => {
    if (previousLock === undefined) delete process.env.LA_PLUMA_MAA_LOCK_FILE;
    else process.env.LA_PLUMA_MAA_LOCK_FILE = previousLock;
    await rm(directory, { recursive: true, force: true });
  });
  const { execMaaCommand } = await import('../maaExecutionService.ts');

  const result = await execMaaCommand(
    'copilot',
    ['PRTS://S12', 'PRTS://S34', '--loop-times', '1'],
    null,
    null,
    true,
    true,
    {},
    { cliPath: executable }
  );

  assert.ok('stdout' in result, 'expected a completed foreground command');
  assert.deepEqual(JSON.parse(String(result.stdout)), [
    'copilot', 'prts://s12', 'prts://s34', '--loop-times', '1'
  ]);
});

