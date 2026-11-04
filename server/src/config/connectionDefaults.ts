import { resolveConnectionDefaults } from './runtimeConfig.ts';

export type { ConnectionDefaults } from './runtimeConfig.ts';
export { resolveConnectionDefaults } from './runtimeConfig.ts';

// 导入时按当前进程环境解析一次：与旧实现 `process.env.X || 缺省` 的读取时机一致。
const processDefaults = resolveConnectionDefaults();

export const DEFAULT_ADB_PATH = processDefaults.adbPath;
export const DEFAULT_ADB_ADDRESS = processDefaults.adbAddress;
export const DEFAULT_CLIENT_TYPE = processDefaults.clientType;
export const DEFAULT_MAA_CLI_PATH = processDefaults.maaCliPath;
