/**
 * 连接默认值具名常量
 *
 * 环境解析由运行配置入口 `./runtimeConfig.ts` 的 `resolveConnectionDefaults`
 * 承担；这里只在模块导入时按当前进程环境解析一次并暴露具名常量，保持既有
 * importer 的读取时机与行为。业务模块不直接读取 `process.env`。
 *
 * 应用内路径与 `LA_PLUMA_*` 覆盖见 `./runtimeConfig.ts`，外部 MAA 目录见
 * `./paths.ts`。
 */

import { resolveConnectionDefaults } from './runtimeConfig.ts';

export type { ConnectionDefaults } from './runtimeConfig.ts';
export { resolveConnectionDefaults } from './runtimeConfig.ts';

// 导入时按当前进程环境解析一次：与旧实现 `process.env.X || 缺省` 的读取时机一致。
const processDefaults = resolveConnectionDefaults();

export const DEFAULT_ADB_PATH = processDefaults.adbPath;
export const DEFAULT_ADB_ADDRESS = processDefaults.adbAddress;
export const DEFAULT_CLIENT_TYPE = processDefaults.clientType;
export const DEFAULT_MAA_CLI_PATH = processDefaults.maaCliPath;
