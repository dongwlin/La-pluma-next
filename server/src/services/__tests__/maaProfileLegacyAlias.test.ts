import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// MAA_CLI_PATH 在模块导入时读取；假 CLI 只应答 `dir config`，指向临时配置目录，
// 让 profile 读写走真实文件而不是真实 maa-cli。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-maa-profile-alias-'));
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');
const configDir = join(fixtureDir, 'maa-config');
const profilesDir = join(configDir, 'profiles');
const profileTomlPath = join(profilesDir, 'default.toml');

await writeFile(fakeCliPath, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== 'dir' || args[1] !== 'config') process.exit(1);
process.stdout.write(process.env.FAKE_MAA_CONFIG_DIR || '');
`, { mode: 0o755 });

process.env.MAA_CLI_PATH = fakeCliPath;
process.env.FAKE_MAA_CONFIG_DIR = configDir;

const { getProfile, mergeMaaProfileConnection, saveProfile } = await import('../maaConfigService.ts');
const { loggerManager } = await import('../../utils/logger.ts');

loggerManager.getLogger('MaaService').enableConsole = false;

async function writeProfile(toml: string): Promise<void> {
  await mkdir(profilesDir, { recursive: true });
  await writeFile(profileTomlPath, toml, 'utf-8');
}

const LEGACY_PROFILE = `[connection]
type = "MuMuPro"
device = "127.0.0.1:5555"
adb_path = "/usr/bin/adb"
config = "CompatMac"
`;

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

test('reading a legacy profile migrates aliases to canonical keys', async () => {
  await writeProfile(LEGACY_PROFILE);

  const { connection } = await getProfile('default');
  assert.equal(connection.preset, 'MuMuPro');
  assert.equal(connection.address, '127.0.0.1:5555');
  assert.equal('type' in connection, false);
  assert.equal('device' in connection, false);
});

test('reading a legacy profile normalizes migrated alias spellings', async () => {
  await writeProfile(`[connection]
type = "PlayTools"
device = "127.0.0.1:16384"
`);

  const { connection } = await getProfile('default');
  assert.equal(connection.preset, 'PlayCover');
  assert.equal(connection.address, '127.0.0.1:16384');
});

test('reading a profile that already carries both spellings prefers canonical values', async () => {
  await writeProfile(`[connection]
type = "ADB"
preset = "MuMuPro"
device = "127.0.0.1:5555"
address = "127.0.0.1:5556"
`);

  const { connection } = await getProfile('default');
  assert.equal(connection.preset, 'MuMuPro');
  assert.equal(connection.address, '127.0.0.1:5556');
  assert.equal('type' in connection, false);
  assert.equal('device' in connection, false);
});

test('saving canonical values over a legacy profile writes no duplicate aliases', async () => {
  await writeProfile(LEGACY_PROFILE);

  await saveProfile('default', {
    connection: {
      adb_path: '/usr/bin/adb',
      address: '127.0.0.1:5555',
      config: 'CompatMac',
      preset: 'ADB',
      auto_reconnect: true
    }
  });

  const toml = await readFile(profileTomlPath, 'utf-8');
  assert.doesNotMatch(toml, /(^|\n)(type|device) *=/);
  assert.match(toml, /preset *= *"ADB"/);
  assert.match(toml, /address *= *"127\.0\.0\.1:5555"/);
  assert.match(toml, /auto_reconnect *= *true/);
});

test('saving an unrelated field on a legacy profile rewrites canonical keys in place', async () => {
  await writeProfile(LEGACY_PROFILE);

  await saveProfile('default', { connection: { config: 'General' } });

  const toml = await readFile(profileTomlPath, 'utf-8');
  assert.doesNotMatch(toml, /(^|\n)(type|device) *=/);
  assert.match(toml, /preset *= *"MuMuPro"/);
  assert.match(toml, /address *= *"127\.0\.0\.1:5555"/);
  assert.match(toml, /adb_path *= *"\/usr\/bin\/adb"/);
  assert.match(toml, /config *= *"General"/);
});

test('saving an unrelated field repairs a profile already carrying both spellings', async () => {
  await writeProfile(`[connection]
type = "ADB"
preset = "MuMuPro"
device = "127.0.0.1:5555"
address = "127.0.0.1:5556"
`);

  await saveProfile('default', { connection: { config: 'CompatMac' } });

  const toml = await readFile(profileTomlPath, 'utf-8');
  assert.doesNotMatch(toml, /(^|\n)(type|device) *=/);
  assert.match(toml, /preset *= *"MuMuPro"/);
  assert.match(toml, /address *= *"127\.0\.0\.1:5556"/);
});

test('saving only instance options leaves the connection section untouched', async () => {
  await writeProfile(`[connection]
type = "MuMuPro"
device = "127.0.0.1:5555"

[instance_options]
touch_mode = "MaaTouch"
`);

  await saveProfile('default', { instance_options: { touch_mode: 'Adb' } });

  const toml = await readFile(profileTomlPath, 'utf-8');
  assert.match(toml, /type *= *"MuMuPro"/);
  assert.match(toml, /device *= *"127\.0\.0\.1:5555"/);
  assert.match(toml, /touch_mode *= *"Adb"/);
});

test('connection merge keeps canonical values over legacy aliases', () => {
  const merged = mergeMaaProfileConnection(
    { connection: { type: 'ADB', device: '127.0.0.1:5555', config: 'CompatMac' } },
    { connection: { preset: 'MuMuPro', address: '127.0.0.1:5556' } }
  );

  assert.deepEqual(merged.connection, {
    config: 'CompatMac',
    preset: 'MuMuPro',
    address: '127.0.0.1:5556'
  });
});
