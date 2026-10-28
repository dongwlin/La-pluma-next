import assert from 'node:assert/strict';
import test from 'node:test';
import TOML from '@iarna/toml';
import {
  getConfig,
  mergeMaaProfileConnection,
  parseMaaProfile,
  saveConfig,
  validateMaaProfileName
} from '../maaConfigService.ts';

// 与 maaConfigService 相同：stringify 的声明参数是内部 JsonMap，运行时接受任意表。
const stringifyToml = TOML.stringify as (document: Record<string, unknown>) => string;

const existingProfile = `
profile_name = "daily"

[connection]
adb_path = "adb"
address = "127.0.0.1:5555"
auto_reconnect = true
retry_count = 3
ports = [5555, 16384]

[resource]
channel = "beta"
auto_update = false

[instance_options]
touch_mode = "maatouch"
`;

function readTable(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test('MAA profile parser preserves native TOML value types', () => {
  const profile = parseMaaProfile(existingProfile);
  const connection = readTable(profile.connection);

  assert.equal(connection.auto_reconnect, true);
  assert.equal(connection.retry_count, 3);
  assert.deepEqual(connection.ports, [5555, 16384]);
  assert.equal(readTable(profile.resource).auto_update, false);
});

test('connection updates preserve unknown profile sections and existing values', () => {
  const parsed = parseMaaProfile(existingProfile);
  const merged = mergeMaaProfileConnection(parsed, {
    connection: {
      address: '192.168.1.10:5555',
      auto_reconnect: false
    }
  });
  const roundTrip = parseMaaProfile(stringifyToml(merged));
  const connection = readTable(roundTrip.connection);

  assert.equal(roundTrip.profile_name, 'daily');
  assert.equal(connection.adb_path, 'adb');
  assert.equal(connection.address, '192.168.1.10:5555');
  assert.equal(connection.auto_reconnect, false);
  assert.equal(connection.retry_count, 3);
  assert.deepEqual(connection.ports, [5555, 16384]);
  assert.deepEqual(roundTrip.resource, { channel: 'beta', auto_update: false });
  assert.deepEqual(roundTrip.instance_options, { touch_mode: 'maatouch' });
});

test('MAA profile names reject traversal before invoking maa-cli', async () => {
  assert.equal(validateMaaProfileName('emulator_2'), 'emulator_2');
  assert.throws(() => validateMaaProfileName('../default'), /连接配置名称不合法/);
  await assert.rejects(getConfig('..%2Fdefault'), /连接配置名称不合法/);
  await assert.rejects(saveConfig('../../default', { connection: {} }), /连接配置名称不合法/);
});
