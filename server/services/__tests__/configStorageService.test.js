import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, test } from 'node:test';
import { resolveAppPaths } from '../../config/runtimeConfig.ts';
import {
  createUserConfigStorage,
  deleteUserConfig,
  getAllUserConfigs,
  loadUserConfig,
  saveUserConfig,
  setConfigStorageDirForTests,
  updateUserConfig,
  validateConfigType
} from '../configStorageService.js';

test('user config storage accepts only its explicit config types', () => {
  assert.equal(validateConfigType('automation-tasks'), 'automation-tasks');
  assert.equal(validateConfigType('notification'), 'notification');
  assert.throws(() => validateConfigType('invalid-config'), /配置类型不合法/);
  assert.throws(() => validateConfigType('../../package'), /配置类型不合法/);
});

test('path traversal values cannot read, write, or delete outside user configs', async () => {
  const traversal = '../../package';
  const readResult = await loadUserConfig(traversal);
  const writeResult = await saveUserConfig(traversal, { name: 'overwritten' });
  const deleteResult = await deleteUserConfig(traversal);

  assert.equal(readResult.success, false);
  assert.equal(readResult.data, undefined);
  assert.equal(writeResult.success, false);
  assert.equal(deleteResult.success, false);
});

describe('saveUserConfig payload validation', () => {
  let storageDir;

  afterEach(async () => {
    setConfigStorageDirForTests(null);
    if (storageDir) {
      await rm(storageDir, { recursive: true, force: true });
      storageDir = null;
    }
  });

  async function useTempStorage() {
    storageDir = await mkdtemp(join(tmpdir(), 'la-pluma-config-payload-'));
    setConfigStorageDirForTests(storageDir);
    return storageDir;
  }

  it('rejects non-object payloads before any filesystem write', async () => {
    const dir = await useTempStorage();

    for (const data of [undefined, null, 'text', 42, ['array'], []]) {
      const result = await saveUserConfig('auto-update', data);
      assert.equal(result.success, false);
      assert.equal(result.error.code, 'AGENT_CONFIG_DATA_INVALID');
      assert.equal(result.error.retryable, false);
    }

    // 校验发生在目录创建之前，存储目录不应有任何配置文件
    assert.deepEqual(await readdir(dir), []);
  });

  it('keeps valid legacy payloads and extension fields, then round-trips them', async () => {
    await useTempStorage();

    const payload = {
      taskFlow: [{ name: 'fight', type: 'fight', enabled: true }],
      legacyField: 'keep-me',
      extension: { nested: { allowed: true } }
    };
    const saveResult = await saveUserConfig('automation-tasks', payload);
    assert.equal(saveResult.success, true);

    const readResult = await loadUserConfig('automation-tasks');
    assert.equal(readResult.success, true);
    assert.deepEqual(readResult.data, payload);

    const allResult = await getAllUserConfigs();
    assert.deepEqual(allResult.data['automation-tasks'], payload);
  });
});

describe('config storage instances', () => {
  const tempDirs = [];

  afterEach(async () => {
    setConfigStorageDirForTests(null);
    while (tempDirs.length) {
      await rm(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  async function trackTempDir(prefix) {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it('keeps two storage instances independent in state and directory', async () => {
    const dirA = await trackTempDir('la-pluma-config-a-');
    const dirB = await trackTempDir('la-pluma-config-b-');
    const storageA = createUserConfigStorage({ configDir: dirA });
    const storageB = createUserConfigStorage({ configDir: dirB });

    const payload = { enabled: true };
    assert.equal((await storageA.saveUserConfig('auto-update', payload)).success, true);

    // B 看不到 A 目录里的内容，缺失文件按契约返回 null
    const fromB = await storageB.loadUserConfig('auto-update');
    assert.equal(fromB.success, true);
    assert.equal(fromB.data, null);
    assert.deepEqual(await readdir(dirB), []);

    // 实例各自持有目录：重定向 A 不影响 B，也不会共享状态
    const dirA2 = await trackTempDir('la-pluma-config-a2-');
    storageA.setConfigDirForTests(dirA2);
    assert.equal((await storageA.saveUserConfig('auto-update', payload)).success, true);
    assert.deepEqual(await readdir(dirA2), ['auto-update.json']);
    assert.deepEqual(await readdir(dirA), ['auto-update.json']);
    assert.deepEqual(await readdir(dirB), []);
  });

  it('defaults to the runtime config userConfigsDir entry without touching real files', async () => {
    const recordedPaths = [];
    const storage = createUserConfigStorage({
      io: {
        ensureDir: async () => undefined,
        readJsonFile: async () => null,
        writeJsonFile: async filePath => {
          recordedPaths.push(filePath);
        },
        updateJsonFile: async () => null,
        deleteJsonFile: async () => false,
        listDir: async () => []
      }
    });

    assert.equal((await storage.saveUserConfig('auto-update', { enabled: true })).success, true);
    assert.deepEqual(
      recordedPaths,
      [join(resolveAppPaths().userConfigsDir, 'auto-update.json')]
    );
  });

  it('keeps missing-file reads on the documented defaults', async () => {
    const dir = await trackTempDir('la-pluma-config-missing-');
    const storage = createUserConfigStorage({ configDir: dir });

    const loaded = await storage.loadUserConfig('roguelike-tasks');
    assert.equal(loaded.success, true);
    assert.equal(loaded.data, null);

    const deleted = await storage.deleteUserConfig('roguelike-tasks');
    assert.equal(deleted.success, true);
    assert.equal(deleted.message, '配置不存在');

    // 读改写的缺失默认值与读取一致：updateFn 收到 null，写回后创建文件
    const updated = await storage.updateUserConfig('roguelike-tasks', current => {
      assert.equal(current, null);
      return { plan: 'seed' };
    });
    assert.equal(updated.success, true);
    assert.deepEqual(updated.data, { plan: 'seed' });
    assert.deepEqual((await storage.loadUserConfig('roguelike-tasks')).data, { plan: 'seed' });
  });

  it('treats save as a whole-file replacement instead of a merge', async () => {
    const dir = await trackTempDir('la-pluma-config-whole-');
    const storage = createUserConfigStorage({ configDir: dir });

    assert.equal((await storage.saveUserConfig('notification', { keep: true, nested: { a: 1 } })).success, true);
    assert.equal((await storage.saveUserConfig('notification', { fresh: true })).success, true);

    const loaded = await storage.loadUserConfig('notification');
    assert.deepEqual(loaded.data, { fresh: true });
  });

  it('fails reads and updates on corrupted files and skips them in getAllUserConfigs', async () => {
    const dir = await trackTempDir('la-pluma-config-corrupt-');
    const storage = createUserConfigStorage({ configDir: dir });

    await writeFile(join(dir, 'notification.json'), '{ not-json', 'utf-8');
    assert.equal((await storage.saveUserConfig('auto-update', { enabled: true })).success, true);
    // 白名单之外的文件不进入聚合结果
    await writeFile(join(dir, 'unknown-type.json'), '{}', 'utf-8');

    const loaded = await storage.loadUserConfig('notification');
    assert.equal(loaded.success, false);
    assert.equal(loaded.error.code, 'AGENT_INTERNAL_ERROR');

    const updated = await storage.updateUserConfig('notification', () => ({ replaced: true }));
    assert.equal(updated.success, false);

    const all = await storage.getAllUserConfigs();
    assert.equal(all.success, true);
    assert.deepEqual(all.data, { 'auto-update': { enabled: true } });
  });

  it('reports write failures through the injected IO port', async () => {
    const storage = createUserConfigStorage({
      configDir: join(tmpdir(), 'la-pluma-config-unused'),
      io: {
        ensureDir: async () => undefined,
        readJsonFile: async () => null,
        writeJsonFile: async () => {
          throw new Error('注入的写入失败');
        },
        updateJsonFile: async () => {
          throw new Error('注入的更新失败');
        },
        deleteJsonFile: async () => {
          throw new Error('注入的删除失败');
        },
        listDir: async () => []
      }
    });

    const saved = await storage.saveUserConfig('auto-update', { enabled: true });
    assert.equal(saved.success, false);
    assert.equal(saved.message, '保存配置失败');

    const updated = await storage.updateUserConfig('auto-update', () => ({}));
    assert.equal(updated.success, false);
    assert.equal(updated.message, '更新配置失败');

    const deleted = await storage.deleteUserConfig('auto-update');
    assert.equal(deleted.success, false);
    assert.equal(deleted.message, '删除配置失败');
  });

  it('keeps the directory intact when the real filesystem write fails', async () => {
    const dir = await trackTempDir('la-pluma-config-writefail-');
    const storage = createUserConfigStorage({ configDir: dir });

    // 目标路径被非空目录占用：原子替换必然失败
    await mkdir(join(dir, 'combat-tasks.json'));
    await writeFile(join(dir, 'combat-tasks.json', 'occupied'), 'x', 'utf-8');

    const saved = await storage.saveUserConfig('combat-tasks', { taskFlow: [] });
    assert.equal(saved.success, false);
    assert.equal(saved.message, '保存配置失败');

    // 失败后不残留临时文件
    assert.deepEqual(await readdir(dir), ['combat-tasks.json']);
  });

  it('serializes concurrent read-modify-writes across the whole queued operation', async () => {
    const dir = await trackTempDir('la-pluma-config-rmw-');
    const storage = createUserConfigStorage({ configDir: dir });

    assert.equal((await storage.saveUserConfig('training-queue', { count: 0 })).success, true);

    const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      storage.updateUserConfig('training-queue', async current => {
        assert.equal(typeof current?.count, 'number', '每次读改写必须读到前序排队操作的结果');
        await new Promise(resolve => setTimeout(resolve, 2));
        return { count: current.count + 1 };
      })
    ));

    // 若只串行最后一次写入，全部并发读改写都会读到 0 并互相覆盖
    results.forEach((result, index) => {
      assert.equal(result.success, true);
      assert.equal(result.data.count, index + 1);
    });

    const final = await storage.loadUserConfig('training-queue');
    assert.deepEqual(final.data, { count: 10 });
  });
});
