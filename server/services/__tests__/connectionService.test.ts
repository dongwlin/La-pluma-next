import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveConnection, resolveConnectionInput } from '../connectionService.ts';
import type { ConnectionProfile } from '../connectionService.ts';
import type { MaaProfileConnection } from '../maaConfigService.ts';
import {
  DEFAULT_ADB_ADDRESS,
  DEFAULT_ADB_PATH,
  DEFAULT_CLIENT_TYPE
} from '../../config/connectionDefaults.ts';

const savedConnection: ConnectionProfile = {
  profileId: 'tablet',
  adbPath: '/saved/adb',
  address: '127.0.0.1:5555',
  clientType: 'Official'
};

test('connection input resolves the selected profile before applying explicit overrides', async () => {
  let selectedProfile: unknown = null;
  const result = await resolveConnectionInput({
    profileId: 'tablet',
    adbPath: ' /custom/adb ',
    address: ' 192.168.1.5:5555 ',
    clientType: 'Bilibili'
  }, {
    allowOverrides: true,
    resolver: async profileId => {
      selectedProfile = profileId;
      return savedConnection;
    }
  });

  assert.equal(selectedProfile, 'tablet');
  assert.deepEqual(result, {
    profileId: 'tablet',
    adbPath: '/custom/adb',
    address: '192.168.1.5:5555',
    clientType: 'Bilibili'
  });
});

test('connection input preserves saved values when overrides are disabled', async () => {
  const result = await resolveConnectionInput({ address: '10.0.0.2:5555' }, {
    resolver: async () => savedConnection
  });

  assert.deepEqual(result, savedConnection);
});

test('connection input ignores blank override values', async () => {
  const result = await resolveConnectionInput({ adbPath: ' ', address: '', clientType: '\t' }, {
    allowOverrides: true,
    resolver: async () => savedConnection
  });

  assert.deepEqual(result, savedConnection);
});

test('connection input ignores non-record request input and non-string overrides', async () => {
  const selectedProfiles: Array<unknown> = [];
  for (const input of [null, 'tablet', 42, ['tablet'], { adbPath: 12, address: { host: 'x' } }]) {
    const result = await resolveConnectionInput(input, {
      allowOverrides: true,
      resolver: async profileId => {
        selectedProfiles.push(profileId);
        return savedConnection;
      }
    });
    assert.deepEqual(result, savedConnection);
  }
  assert.deepEqual(selectedProfiles, [undefined, undefined, undefined, undefined, undefined]);
});

test('connection profiles reject unsafe ids with a stable validation error', async () => {
  for (const profileId of ['', '../default', '_hidden', 'a'.repeat(65)]) {
    await assert.rejects(
      resolveConnection(profileId),
      (error: unknown) => {
        const validationError = error as {
          code?: unknown;
          statusCode?: unknown;
          retryable?: unknown;
          details?: unknown;
        };
        assert.equal(validationError.code, 'AGENT_VALIDATION_PROFILE_ID_INVALID');
        assert.equal(validationError.statusCode, 400);
        assert.equal(validationError.retryable, false);
        assert.deepEqual(validationError.details, { profileId });
        return true;
      }
    );
  }
});

test('connection profiles read snake_case fields and keep the camelCase alias', async () => {
  const snakeCase: MaaProfileConnection = {
    adb_path: '/saved/adb',
    address: '127.0.0.1:5555',
    client_type: 'Bilibili'
  };
  const fromSnakeCase = await resolveConnection(' tablet ', {
    readConfig: async () => snakeCase
  });
  assert.deepEqual(fromSnakeCase, {
    profileId: 'tablet',
    adbPath: '/saved/adb',
    address: '127.0.0.1:5555',
    clientType: 'Bilibili'
  });

  const fromAlias = await resolveConnection('tablet', {
    readConfig: async () => ({
      adbPath: '/alias/adb',
      address: '10.0.0.2:5555',
      clientType: 'YoStarEN'
    })
  });
  assert.deepEqual(fromAlias, {
    profileId: 'tablet',
    adbPath: '/alias/adb',
    address: '10.0.0.2:5555',
    clientType: 'YoStarEN'
  });

  const mixed = await resolveConnection('tablet', {
    readConfig: async () => ({
      adb_path: '/snake/adb',
      adbPath: '/alias/adb',
      address: '10.0.0.3:5555',
      client_type: 'Official',
      clientType: 'Bilibili'
    })
  });
  assert.equal(mixed.adbPath, '/snake/adb');
  assert.equal(mixed.clientType, 'Official');
});

test('connection profiles fall back to connection defaults for missing or invalid values', async () => {
  const result = await resolveConnection('default', {
    readConfig: async () => ({
      adb_path: '',
      adbPath: 42,
      address: null,
      client_type: { name: 'Official' }
    })
  });

  assert.deepEqual(result, {
    profileId: 'default',
    adbPath: DEFAULT_ADB_PATH,
    address: DEFAULT_ADB_ADDRESS,
    clientType: DEFAULT_CLIENT_TYPE
  });
});

test('connection profiles keep the profile-specific error when the reader fails', async () => {
  const failure = new Error('配置读取失败');
  await assert.rejects(
    resolveConnection('tablet', {
      readConfig: async () => {
        throw failure;
      }
    }),
    error => error === failure
  );
});
