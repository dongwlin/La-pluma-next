import assert from 'node:assert/strict';
import test from 'node:test';
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
