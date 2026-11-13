import { spawn } from 'node:child_process';
import { DEFAULT_MAA_CLI_PATH } from '../src/config/connectionDefaults.ts';
import { prepareResourceGitEnvironment } from '../src/services/resourceGitTransport.ts';
import { isDirectExecution } from './scriptSupport.ts';

if (isDirectExecution(import.meta.url)) {
  try {
    const env = await prepareResourceGitEnvironment('install', DEFAULT_MAA_CLI_PATH, process.env);
    const child = spawn(DEFAULT_MAA_CLI_PATH, ['install', '--force'], { env, stdio: 'inherit' });
    child.once('error', (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    child.once('exit', (code) => { process.exitCode = code ?? 1; });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
