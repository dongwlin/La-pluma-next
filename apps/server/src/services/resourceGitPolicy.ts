import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import TOML from '@iarna/toml';
import { OFFICIAL_RESOURCE_GIT_URL } from '../config/resourceRepository.ts';

const execFileAsync = promisify(execFile);
const CLI_CONFIG_FILES = ['cli.json', 'cli.yaml', 'cli.yml', 'cli.toml'] as const;
const SSH_SETTINGS = ['use_ssh_agent', 'ssh_key', 'passphrase'] as const;
const PROBE_TIMEOUT_MS = 15_000;

interface ResourceGitProbeOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface ResourceGitUpdateOptions extends ResourceGitProbeOptions {
  cliPath: string;
  automatic: boolean;
}

export interface ResourceGitUpdate {
  checkoutPath: string;
  hasCheckout: boolean;
  backend: 'git' | 'libgit2';
}

async function runProbe(
  file: string, args: readonly string[], { cwd, env }: ResourceGitProbeOptions
): Promise<string> {
  const { stdout } = await execFileAsync(file, args, { cwd, env, timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' });
  return stdout;
}

export function runResourceGitProbe(args: readonly string[], options: ResourceGitProbeOptions): Promise<string> {
  return runProbe('git', args, options);
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function removeLineEnding(value: string): string {
  return value.replace(/\r?\n$/, '');
}

async function readMaaDirectory(name: 'config' | 'hot-update', options: ResourceGitUpdateOptions): Promise<string> {
  try {
    const directory = removeLineEnding(await runProbe(options.cliPath, ['dir', name], options));
    if (directory.length > 0) return resolve(options.cwd, directory);
  } catch (error) {
    throw new Error(`无法通过 maa dir ${name} 读取资源更新所需的目录，请检查 maa-cli 安装和目录配置。`, { cause: error });
  }
  throw new Error(`maa dir ${name} 未返回目录，请检查 maa-cli 安装和目录配置。`);
}

async function readResourceSettings(options: ResourceGitUpdateOptions): Promise<{
  path: string;
  resource: Record<string, unknown>;
}> {
  const configDir = await readMaaDirectory('config', options);
  for (const filename of CLI_CONFIG_FILES) {
    const path = join(configDir, filename);
    try {
      if (!await pathExists(path)) continue;
      let document: unknown;
      if (filename === 'cli.toml') {
        document = TOML.parse(await readFile(path, 'utf8'));
      } else {
        const json = filename === 'cli.json'
          ? await readFile(path, 'utf8')
          : await runProbe(options.cliPath, ['convert', path, '--format', 'json'], options);
        document = JSON.parse(json);
      }
      if (isTable(document) && (document.resource === undefined || isTable(document.resource))) {
        return { path, resource: document.resource ?? {} };
      }
    } catch {
      throw new Error(`无法读取 maa-cli 配置 ${path}，请检查文件内容和权限。`);
    }
    throw new Error(`maa-cli 配置 ${path} 的 resource 格式不合法，请修正后重试。`);
  }
  return { path: join(configDir, 'cli.toml'), resource: {} };
}

function invalidSetting(path: string, field: string, correction: string): Error {
  return new Error(`请修正 maa-cli 配置 ${path} 中的 ${field}：${correction}。`);
}

function activeGitBackend(
  resource: Record<string, unknown>, path: string, automatic: boolean
): ResourceGitUpdate['backend'] | null {
  if (automatic && (resource.auto_update === undefined || resource.auto_update === false)) return null;

  const { source, remote } = resource;
  if (isTable(source) && source.type === 'mirrorchyan') return null;
  if (source != null && (!isTable(source) || source.type !== 'git')) {
    throw invalidSetting(path, 'resource.source', '指定 git 或 mirrorchyan 来源');
  }
  if (remote != null && !isTable(remote)) {
    throw invalidSetting(path, 'resource.remote', '使用有效的配置表');
  }
  if (source != null && (resource.backend != null || remote != null)) {
    throw invalidSetting(path, 'resource.source', '移除旧版 resource.backend 和 resource.remote');
  }

  const settings = source ?? remote ?? {};
  const prefix = source == null ? 'resource.remote' : 'resource.source';
  for (const key of SSH_SETTINGS) {
    if (Object.hasOwn(settings, key)) {
      throw invalidSetting(path, `${prefix}.${key}`, '移除 SSH 设置');
    }
  }
  if (Object.hasOwn(settings, 'url') && settings.url !== OFFICIAL_RESOURCE_GIT_URL) {
    throw invalidSetting(path, `${prefix}.url`, `移除此项或设置为 ${OFFICIAL_RESOURCE_GIT_URL}`);
  }
  if (typeof settings.branch === 'string' && settings.branch.startsWith('-')) {
    throw invalidSetting(path, `${prefix}.branch`, '使用有效的 Git 分支名称');
  }

  const backend = source == null ? resource.backend : source.backend;
  if (backend == null) return 'git';
  if (backend === 'git' || backend === 'libgit2') return backend;
  throw invalidSetting(path, source == null ? 'resource.backend' : 'resource.source.backend', '使用 git 或 libgit2');
}

async function assertOfficialCheckout(checkoutPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  const options = { cwd: checkoutPath, env };
  const invalidOrigin = new Error(`请检查资源 checkout ${checkoutPath} 的 Git 配置，将 origin 的唯一拉取地址设为 ${OFFICIAL_RESOURCE_GIT_URL}。`);
  if (!await pathExists(join(checkoutPath, '.git'))) throw invalidOrigin;
  try {
    const [topLevel, origin] = await Promise.all([
      runResourceGitProbe(['rev-parse', '--show-toplevel'], options),
      runResourceGitProbe(['config', '--local', '--includes', '--null', '--get-all', 'remote.origin.url'], options)
    ]);
    if (await realpath(removeLineEnding(topLevel)) === await realpath(checkoutPath) && origin === `${OFFICIAL_RESOURCE_GIT_URL}\0`) return;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT'
      && 'syscall' in error && error.syscall === 'spawn git') {
      throw new Error(`无法通过 Git 核验资源 checkout ${checkoutPath} 的 origin，请安装系统 Git 后重试。`);
    }
    throw invalidOrigin;
  }
  throw invalidOrigin;
}

export async function inspectResourceGitUpdate(options: ResourceGitUpdateOptions): Promise<ResourceGitUpdate | null> {
  const { path, resource } = await readResourceSettings(options);
  const backend = activeGitBackend(resource, path, options.automatic);
  if (backend === null) return null;

  const checkoutPath = await readMaaDirectory('hot-update', options);
  const hasCheckout = await pathExists(checkoutPath);
  if (hasCheckout) await assertOfficialCheckout(checkoutPath, options.env);
  return { checkoutPath, hasCheckout, backend };
}
