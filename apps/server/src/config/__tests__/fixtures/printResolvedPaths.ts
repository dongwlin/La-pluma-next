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
  maaConfigDir: maaPaths.configDir
}));
