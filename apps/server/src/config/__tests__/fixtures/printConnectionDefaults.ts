import {
  DEFAULT_ADB_ADDRESS,
  DEFAULT_ADB_PATH,
  DEFAULT_CLIENT_TYPE,
  DEFAULT_MAA_CLI_PATH
} from '../../connectionDefaults.ts';
import { resolveConnectionDefaults } from '../../runtimeConfig.ts';

const imported = {
  adbPath: DEFAULT_ADB_PATH,
  adbAddress: DEFAULT_ADB_ADDRESS,
  clientType: DEFAULT_CLIENT_TYPE,
  maaCliPath: DEFAULT_MAA_CLI_PATH
};

process.env.ADB_PATH = '/after-import/adb';
process.env.MAA_CLI_PATH = '/after-import/maa';

const afterImportMutation = {
  adbPath: DEFAULT_ADB_PATH,
  adbAddress: DEFAULT_ADB_ADDRESS,
  clientType: DEFAULT_CLIENT_TYPE,
  maaCliPath: DEFAULT_MAA_CLI_PATH
};

process.stdout.write(JSON.stringify({
  imported,
  afterImportMutation,
  resolvedEmpty: resolveConnectionDefaults({})
}));
