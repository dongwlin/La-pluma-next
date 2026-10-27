/**
 * fixture：以子进程运行，打印配置入口的解析结果。
 * 用于验证从不同 cwd 启动时路径与 cwd 无关，以及导入时不固化进程环境
 * （父进程注入 LA_PLUMA_AGENT_RUN_STORE，本脚本显式传空环境解析默认值）。
 */
import { resolveAppPaths } from '../../runtimeConfig.ts';
import { resolveMaaPaths } from '../../paths.ts';

const appPaths = resolveAppPaths({ env: {} });
const maaPaths = resolveMaaPaths({ env: {}, platform: 'linux', homedir: '/fixture-home' });

process.stdout.write(JSON.stringify({
  serverRoot: appPaths.serverRoot,
  appDataDir: appPaths.appDataDir,
  frontendDistDir: appPaths.frontendDistDir,
  agentRunStorePath: appPaths.agentRunStorePath,
  dropRecordsDir: appPaths.dropRecordsDir,
  executionLockPath: appPaths.executionLockPath,
  trainingDataDir: appPaths.trainingDataDir,
  tempResourceDir: appPaths.tempResourceDir,
  maaConfigDir: maaPaths.configDir
}));
