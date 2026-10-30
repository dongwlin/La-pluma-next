import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_MAA_CLI_PATH } from '../config/connectionDefaults.ts';

const execFilePromise = promisify(execFile);

/** `maa dir cache` 只解析一次；失败后在短冷却期内复用同一个错误。 */
const CACHE_DIR_FAILURE_TTL_MS = 30_000;
const CACHE_DIR_TIMEOUT_MS = 15_000;

const cacheDirPromises = new Map<string, Promise<string>>();
const cacheDirFailures = new Map<string, { error: unknown; at: number }>();

async function resolveMaaCacheDir(cliPath: string, env: NodeJS.ProcessEnv): Promise<string> {
  const override = env.MAA_CACHE_DIR?.trim();
  if (override) return override;

  const failure = cacheDirFailures.get(cliPath);
  if (failure) {
    if (Date.now() - failure.at < CACHE_DIR_FAILURE_TTL_MS) throw failure.error;
    cacheDirFailures.delete(cliPath);
  }

  let pending = cacheDirPromises.get(cliPath);
  if (!pending) {
    pending = execFilePromise(cliPath, ['dir', 'cache'], {
      env,
      timeout: CACHE_DIR_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024
    })
      .then(result => String(result.stdout).trim())
      .then(cacheDir => {
        if (!cacheDir) throw new Error('无法获取 MAA 缓存目录');
        return cacheDir;
      })
      .catch(error => {
        cacheDirFailures.set(cliPath, { error, at: Date.now() });
        cacheDirPromises.delete(cliPath);
        throw error;
      });
    cacheDirPromises.set(cliPath, pending);
  }
  return pending;
}

const LOCAL_RESOURCE_COMMANDS: ReadonlySet<string> = new Set([
  'startup', 'closedown', 'fight', 'run', 'infrast', 'recruit', 'mall', 'award',
  'depot', 'operbox', 'roguelike', 'reclamation'
]);

const RESOURCE_TARGETS: readonly string[][] = [
  [],
  ['platform_diff', 'iOS', 'resource'],
  ...['YoStarEN', 'YoStarJP', 'YoStarKR', 'txwy'].map(client => ['global', client, 'resource'])
];

// maa-cli 0.7.7 checks all clients, even when running a single Official stage.
// Include the legacy task paths too, for CLI versions using flat task files.
const HOT_UPDATE_FILES: readonly string[] = [
  'StageActivityV2.json',
  ...RESOURCE_TARGETS.flatMap(target => [
    join('resource', ...target, 'tasks', 'tasks.json'),
    join('resource', ...target, 'tasks.json')
  ])
];

/** 私有任务缓存的对外形状：替换后的环境变量与清理入口。 */
export interface MaaTaskCache {
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

/** 缓存准备端口：CLI 路径与环境变量可覆盖，测试可用临时目录替代共享缓存。 */
export interface MaaTaskCacheOptions {
  cliPath?: string;
  env?: NodeJS.ProcessEnv;
}

function errorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

async function readCachedJson(path: string): Promise<string> {
  try {
    const content = await readFile(path, 'utf-8');
    const value: unknown = JSON.parse(content);
    if (value && typeof value === 'object' && !Array.isArray(value)) return content;
  } catch (error) {
    if (errorCodeOf(error) !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  // These are optional overlays. An empty object leaves installed resources intact.
  return '{}';
}

/**
 * Snapshot optional hot-update files for local tasks. Fresh, private ETag sidecars
 * keep maa-cli's mandatory startup updater local without marking the real cache
 * as remotely checked. Explicit update/activity/copilot commands keep their cache.
 */
export async function prepareMaaTaskCache(command: string, {
  cliPath = DEFAULT_MAA_CLI_PATH,
  env = process.env
}: MaaTaskCacheOptions = {}): Promise<MaaTaskCache | null> {
  if (!LOCAL_RESOURCE_COMMANDS.has(command)) return null;

  const cacheDir = await resolveMaaCacheDir(cliPath, env);
  if (!cacheDir) throw new Error('无法获取 MAA 缓存目录');

  const taskCacheDir = await mkdtemp(join(tmpdir(), 'la-pluma-maa-task-'));
  const cleanup = async (): Promise<void> => {
    await rm(taskCacheDir, { recursive: true, force: true });
  };

  try {
    for (const file of HOT_UPDATE_FILES) {
      const content = await readCachedJson(join(cacheDir, file));
      const destination = join(taskCacheDir, file);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, 'utf-8');
      await writeFile(`${destination}.etag`, '"la-pluma-local-task"', 'utf-8');
    }

    return { env: { ...env, MAA_CACHE_DIR: taskCacheDir }, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
