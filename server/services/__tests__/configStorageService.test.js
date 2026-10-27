import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, test } from 'node:test';
import {
  deleteUserConfig,
  getAllUserConfigs,
  loadUserConfig,
  saveUserConfig,
  setConfigStorageDirForTests,
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
