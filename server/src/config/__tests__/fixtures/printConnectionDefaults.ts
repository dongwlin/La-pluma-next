/**
 * fixture：以子进程运行，打印连接默认值适配的解析结果。
 * 验证导入时按进程环境解析一次（之后修改环境不改变常量），且显式传入的
 * 空环境仍按缺省值解析，不把进程环境固化成共享全局。
 */
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

// 导入后再修改进程环境：具名常量不应随之变化。
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
