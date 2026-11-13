import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getConfig,
  saveConfig,
  validateMaaProfileName
} from '../maaConfigService.ts';

test('MAA profile names reject traversal before invoking maa-cli', async () => {
  assert.equal(validateMaaProfileName('emulator_2'), 'emulator_2');
  assert.throws(() => validateMaaProfileName('../default'), /连接配置名称不合法/);
  await assert.rejects(getConfig('..%2Fdefault'), /连接配置名称不合法/);
  await assert.rejects(saveConfig('../../default', { connection: {} }), /连接配置名称不合法/);
});
