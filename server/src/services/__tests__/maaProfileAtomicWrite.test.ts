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

const { getConfig, saveConfig } = await import('../maaConfigService.ts');
const { loggerManager } = await import('../../utils/logger.ts');

loggerManager.getLogger('MaaService').enableConsole = false;

const sampleProfile = `profile_name = "daily"

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
      auto_reconnect: false,
      retry_count: 3,
      ports: [5555, 16384],
      probe: 'kept'
    });
    assert.deepEqual(parsed.resource, { channel: 'beta', auto_update: false });
    assert.deepEqual(parsed.instance_options, { touch_mode: 'maatouch' });
    // 写入的是 TOML 而不是 JSON，且 getter 仍按 connection 读取。
    assert.match(content, /^profile_name = "daily"/);
    assert.deepEqual(await getConfig('daily'), parsed.connection);
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
