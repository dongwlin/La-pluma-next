import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_MAA_CLI_PATH } from '../config/connectionDefaults.js';

const execFilePromise = promisify(execFile);

const LOCAL_RESOURCE_COMMANDS = new Set([
  'startup', 'closedown', 'fight', 'run', 'infrast', 'recruit', 'mall', 'award',
  'depot', 'operbox', 'roguelike', 'reclamation'
]);

const RESOURCE_TARGETS = [
  [],
  ['platform_diff', 'iOS', 'resource'],
  ...['YoStarEN', 'YoStarJP', 'YoStarKR', 'txwy'].map(client => ['global', client, 'resource'])
];

// maa-cli 0.7.7 checks all clients, even when running a single Official stage.
// Include the legacy task paths too, for CLI versions using flat task files.
const HOT_UPDATE_FILES = [
  'StageActivityV2.json',
  ...RESOURCE_TARGETS.flatMap(target => [
    join('resource', ...target, 'tasks', 'tasks.json'),
    join('resource', ...target, 'tasks.json')
  ])
];

async function readCachedJson(path) {
  try {
    const content = await readFile(path, 'utf-8');
    const value = JSON.parse(content);
    if (value && typeof value === 'object' && !Array.isArray(value)) return content;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  // These are optional overlays. An empty object leaves installed resources intact.
  return '{}';
}

/**
 * Snapshot optional hot-update files for local tasks. Fresh, private ETag sidecars
 * keep maa-cli's mandatory startup updater local without marking the real cache
 * as remotely checked. Explicit update/activity/copilot commands keep their cache.
 */
export async function prepareMaaTaskCache(command, {
  cliPath = DEFAULT_MAA_CLI_PATH,
  env = process.env
} = {}) {
  if (!LOCAL_RESOURCE_COMMANDS.has(command)) return null;

  const cacheDir = env.MAA_CACHE_DIR?.trim() || (await execFilePromise(
    cliPath, ['dir', 'cache'], { env }
  )).stdout.trim();
  if (!cacheDir) throw new Error('无法获取 MAA 缓存目录');

  const taskCacheDir = await mkdtemp(join(tmpdir(), 'la-pluma-maa-task-'));
  const cleanup = () => rm(taskCacheDir, { recursive: true, force: true });

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
