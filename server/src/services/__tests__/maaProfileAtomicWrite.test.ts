import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import TOML from '@iarna/toml';

// MAA_CLI_PATH 在模块导入时读取；先准备只回答 `dir config` 的假 CLI，
// 让 profile 读写全部落在临时目录，不接触真实 MAA 配置。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-maa-profile-'));
const configDir = join(fixtureDir, 'maa-config');
const profilesDir = join(configDir, 'profiles');
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');
await writeFile(fakeCliPath, `#!${process.execPath}
if (process.argv[2] === 'dir' && process.argv[3] === 'config') {
  process.stdout.write(process.env.FAKE_MAA_CONFIG_DIR || '');
} else {
  process.exit(1);
}
`, { mode: 0o755 });
process.env.MAA_CLI_PATH = fakeCliPath;
process.env.FAKE_MAA_CONFIG_DIR = configDir;

const { getConfig, getProfile, saveConfig, saveProfile } = await import('../maaConfigService.ts');
const { loggerManager } = await import('../../utils/logger.ts');

loggerManager.getLogger('MaaService').enableConsole = false;

const sampleProfile = `profile_name = "daily"

[connection]
adb_path = "adb"
address = "127.0.0.1:5555"
retry_count = 3
ports = [5555, 16384]

[behavior]
auto_reconnect = true

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

function profilePath(profileName: string): string {
  return join(profilesDir, `${profileName}.toml`);
}

async function writeProfile(profileName: string, content: string): Promise<void> {
  await mkdir(profilesDir, { recursive: true });
  await writeFile(profilePath(profileName), content, 'utf-8');
}

async function readProfile(profileName: string): Promise<string> {
  return readFile(profilePath(profileName), 'utf-8');
}

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('MAA profile atomic text write', () => {
  beforeEach(async () => {
    await rm(profilesDir, { recursive: true, force: true });
  });

  it('writes merged connection back as TOML and keeps unrelated sections', async () => {
    await writeProfile('daily', sampleProfile);

    await saveConfig('daily', {
      connection: { address: '192.168.1.10:5555', auto_reconnect: false, probe: 'kept' }
    });

    const content = await readProfile('daily');
    const parsed = TOML.parse(content);
    assert.equal(parsed.profile_name, 'daily');
    assert.deepEqual(parsed.connection, {
      adb_path: 'adb',
      address: '192.168.1.10:5555',
      retry_count: 3,
      ports: [5555, 16384],
      probe: 'kept'
    });
    assert.deepEqual(parsed.behavior, { auto_reconnect: false });
    assert.deepEqual(parsed.resource, { channel: 'beta', auto_update: false });
    assert.deepEqual(parsed.instance_options, { touch_mode: 'maatouch' });
    // 写入的是 TOML 而不是 JSON，auto_reconnect 由 behavior 段回到 connection 读取视图。
    assert.match(content, /^profile_name = "daily"/);
    assert.deepEqual(await getConfig('daily'), {
      ...parsed.connection,
      auto_reconnect: false
    });
  });

  it('migrates a legacy connection auto_reconnect value into behavior', async () => {
    await writeProfile('legacy', `[connection]
address = "127.0.0.1:5555"
auto_reconnect = false
`);

    assert.deepEqual(await getConfig('legacy'), {
      address: '127.0.0.1:5555',
      auto_reconnect: false
    });

    await saveConfig('legacy', { connection: { address: '10.0.0.2:5555' } });

    const parsed = TOML.parse(await readProfile('legacy'));
    assert.deepEqual(parsed.connection, { address: '10.0.0.2:5555' });
    assert.deepEqual(parsed.behavior, { auto_reconnect: false });
    assert.deepEqual(await getConfig('legacy'), {
      address: '10.0.0.2:5555',
      auto_reconnect: false
    });
  });

  it('reads behavior auto_reconnect ahead of a stale connection value', async () => {
    await writeProfile('mixed', `[connection]
address = "127.0.0.1:5555"
auto_reconnect = false

[behavior]
auto_reconnect = true
`);

    assert.deepEqual(await getConfig('mixed'), {
      address: '127.0.0.1:5555',
      auto_reconnect: true
    });
  });

  it('keeps unrelated behavior fields and rejects a non-table behavior section', async () => {
    await writeProfile('behavior-extra', `[connection]
address = "127.0.0.1:5555"

[behavior]
auto_reconnect = true
probe = "kept"
`);
    await saveConfig('behavior-extra', { connection: { auto_reconnect: false } });

    const parsed = TOML.parse(await readProfile('behavior-extra'));
    assert.deepEqual(parsed.connection, { address: '127.0.0.1:5555' });
    assert.deepEqual(parsed.behavior, { auto_reconnect: false, probe: 'kept' });

    const corrupted = `behavior = "not-a-table"

[connection]
address = "127.0.0.1:5555"
`;
    await writeProfile('corrupted-behavior', corrupted);
    await assert.rejects(
      saveConfig('corrupted-behavior', { connection: { auto_reconnect: true } }),
      /保存配置失败: 现有 behavior section 格式不合法/
    );
    assert.equal(await readProfile('corrupted-behavior'), corrupted);
  });

  it('creates a missing profile with only the connection section', async () => {
    await saveConfig('fresh', { connection: { address: '127.0.0.1:16384' } });

    assert.deepEqual(TOML.parse(await readProfile('fresh')), {
      connection: { address: '127.0.0.1:16384' }
    });
    assert.deepEqual(await readdir(profilesDir), ['fresh.toml']);
  });

  it('serializes concurrent saves for the same profile without losing updates', async () => {
    await writeProfile('daily', sampleProfile);

    const probeCount = 12;
    await Promise.all(Array.from({ length: probeCount }, (_, index) =>
      saveConfig('daily', { connection: { [`probe_${index}`]: index } })
    ));

    const parsed = TOML.parse(await readProfile('daily'));
    const connection = readTable(parsed.connection);
    for (let index = 0; index < probeCount; index++) {
      assert.equal(connection[`probe_${index}`], index);
    }
    assert.equal(connection.address, '127.0.0.1:5555');
    assert.deepEqual(parsed.resource, { channel: 'beta', auto_update: false });
    assert.deepEqual(await readdir(profilesDir), ['daily.toml']);
  });

  it('saves different profiles independently', async () => {
    await writeProfile('daily', sampleProfile);
    await writeProfile('weekly', sampleProfile.replace('profile_name = "daily"', 'profile_name = "weekly"'));

    await Promise.all([
      saveConfig('daily', { connection: { address: '10.0.0.1:5555' } }),
      saveConfig('weekly', { connection: { address: '10.0.0.2:5555' } })
    ]);

    assert.equal(readTable(readTable(TOML.parse(await readProfile('daily'))).connection).address, '10.0.0.1:5555');
    assert.equal(readTable(readTable(TOML.parse(await readProfile('weekly'))).connection).address, '10.0.0.2:5555');
    assert.equal((await getConfig('weekly')).address, '10.0.0.2:5555');
    assert.deepEqual((await readdir(profilesDir)).sort(), ['daily.toml', 'weekly.toml']);
  });

  it('fails explicitly on corrupted TOML and keeps the original file', async () => {
    const corrupted = 'profile_name = "daily"\n[connection\naddress = ';
    await writeProfile('daily', corrupted);

    await assert.rejects(
      saveConfig('daily', { connection: { address: '127.0.0.1:5555' } }),
      /保存配置失败/
    );

    assert.equal(await readProfile('daily'), corrupted);
    assert.deepEqual(await readdir(profilesDir), ['daily.toml']);
  });

  it('keeps the existing profile when the write fails', {
    skip: process.platform === 'win32' || process.getuid?.() === 0
  }, async () => {
    await writeProfile('daily', sampleProfile);
    await chmod(profilesDir, 0o555);
    try {
      await assert.rejects(
        saveConfig('daily', { connection: { address: '127.0.0.1:5555' } }),
        /保存配置失败/
      );
    } finally {
      await chmod(profilesDir, 0o755);
    }

    assert.equal(await readProfile('daily'), sampleProfile);
    assert.deepEqual(await readdir(profilesDir), ['daily.toml']);
  });

  it('fails explicitly when the profiles directory cannot be created', async () => {
    await rm(profilesDir, { recursive: true, force: true });
    await writeFile(profilesDir, 'not a directory', 'utf-8');

    await assert.rejects(
      saveConfig('daily', { connection: { address: '127.0.0.1:5555' } }),
      /保存配置失败/
    );

    assert.equal(await readFile(profilesDir, 'utf-8'), 'not a directory');
  });

  it('keeps the existing profile file permission bits', { skip: process.platform === 'win32' }, async () => {
    await writeProfile('daily', sampleProfile);
    await chmod(profilePath('daily'), 0o640);

    await saveConfig('daily', { connection: { address: '127.0.0.1:5555' } });

    assert.equal((await stat(profilePath('daily'))).mode & 0o777, 0o640);
  });

  it('does not overwrite a read-only profile file', {
    skip: process.platform === 'win32' || process.getuid?.() === 0
  }, async () => {
    await writeProfile('daily', sampleProfile);
    await chmod(profilePath('daily'), 0o444);
    try {
      await assert.rejects(
        saveConfig('daily', { connection: { address: '127.0.0.1:5555' } }),
        /保存配置失败/
      );
      assert.equal(await readProfile('daily'), sampleProfile);
    } finally {
      await chmod(profilePath('daily'), 0o644);
    }

    assert.deepEqual(await readdir(profilesDir), ['daily.toml']);
  });
});

describe('MAA profile presets and instance options', () => {
  beforeEach(async () => {
    await rm(profilesDir, { recursive: true, force: true });
  });

  it('reads preset aliases and normalizes the touch mode casing', async () => {
    await writeProfile('preset', `[connection]
preset = "playtools"
address = "127.0.0.1:5555"

[instance_options]
touch_mode = "maatouch"
deployment_with_pause = false
custom_flag = "kept"
`);

    const profile = await getProfile('preset');
    assert.deepEqual(profile.connection, {
      preset: 'PlayCover',
      address: '127.0.0.1:5555'
    });
    assert.deepEqual(profile.instance_options, {
      touch_mode: 'MaaTouch',
      deployment_with_pause: false,
      custom_flag: 'kept'
    });
  });

  it('writes instance options without touching connection, behavior or other sections', async () => {
    await writeProfile('daily', sampleProfile);

    await saveProfile('daily', {
      instance_options: { touch_mode: 'MiniTouch', adb_lite_enabled: true }
    });

    const parsed = TOML.parse(await readProfile('daily'));
    assert.deepEqual(parsed.connection, {
      adb_path: 'adb',
      address: '127.0.0.1:5555',
      retry_count: 3,
      ports: [5555, 16384]
    });
    assert.deepEqual(parsed.behavior, { auto_reconnect: true });
    assert.deepEqual(parsed.resource, { channel: 'beta', auto_update: false });
    assert.deepEqual(parsed.instance_options, {
      touch_mode: 'MiniTouch',
      adb_lite_enabled: true
    });
  });

  it('rejects unknown presets and touch modes without writing the profile', async () => {
    await writeProfile('daily', sampleProfile);
    const original = await readProfile('daily');

    await assert.rejects(
      saveProfile('daily', { connection: { preset: 'Nope' } }),
      (error: unknown) => {
        const validationError = error as { code?: unknown; statusCode?: unknown; details?: unknown };
        assert.equal(validationError.code, 'AGENT_CONFIG_PROFILE_INVALID');
        assert.equal(validationError.statusCode, 400);
        assert.deepEqual(validationError.details, { field: 'connection.preset', value: 'Nope' });
        return true;
      }
    );
    await assert.rejects(
      saveProfile('daily', { instance_options: { touch_mode: 'Unknown' } }),
      (error: unknown) => {
        const validationError = error as { code?: unknown; statusCode?: unknown };
        assert.equal(validationError.code, 'AGENT_CONFIG_PROFILE_INVALID');
        assert.equal(validationError.statusCode, 400);
        return true;
      }
    );
    assert.equal(await readProfile('daily'), original);
  });

  it('keeps other sections out of the connection view when the profile has no connection table', async () => {
    await writeProfile('options-only', `[instance_options]
touch_mode = "MaaTouch"

[resource]
user_resource = true
`);

    const profile = await getProfile('options-only');
    assert.deepEqual(profile.connection, {});
    assert.deepEqual(profile.instance_options, { touch_mode: 'MaaTouch' });

    await saveProfile('options-only', { connection: { address: '127.0.0.1:5555' } });

    const parsed = TOML.parse(await readProfile('options-only'));
    assert.deepEqual(parsed.connection, { address: '127.0.0.1:5555' });
    assert.deepEqual(parsed.instance_options, { touch_mode: 'MaaTouch' });
    assert.deepEqual(parsed.resource, { user_resource: true });
  });

  it('migrates legacy connection and instance options into their sections', async () => {
    await writeProfile('legacy-options', `[connection]
address = "127.0.0.1:5555"
preset = "Waydroid"
auto_reconnect = true
`);

    await saveProfile('legacy-options', {
      connection: { address: '10.0.0.9:5555' },
      instance_options: { touch_mode: 'Adb' }
    });

    const parsed = TOML.parse(await readProfile('legacy-options'));
    assert.deepEqual(parsed.connection, { address: '10.0.0.9:5555', preset: 'Waydroid' });
    assert.deepEqual(parsed.behavior, { auto_reconnect: true });
    assert.deepEqual(parsed.instance_options, { touch_mode: 'Adb' });
  });
});
