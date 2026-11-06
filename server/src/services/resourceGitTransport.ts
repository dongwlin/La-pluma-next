import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { OFFICIAL_RESOURCE_GIT_URL } from '../config/resourceRepository.ts';
import { inspectResourceGitUpdate, runResourceGitProbe } from './resourceGitPolicy.ts';

const EXPLICIT_UPDATE_COMMANDS = new Set(['install', 'update', 'hot-update']);
const AUTO_UPDATE_COMMANDS = new Set([
  'run', 'startup', 'closedown', 'fight', 'copilot', 'ssscopilot', 'paradoxcopilot',
  'roguelike', 'reclamation', 'infrast', 'recruit', 'mall', 'award', 'depot', 'operbox'
]);

interface GitContext {
  env: NodeJS.ProcessEnv;
  cwd: string;
}

function resourceGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe = { ...env };
  for (const key of [
    'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG',
    'GIT_IMPLICIT_WORK_TREE', 'GIT_PREFIX', 'GIT_INTERNAL_SUPER_PREFIX'
  ]) delete safe[key];
  return safe;
}

function libgit2Env(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const native = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_CONFIG_')));
  if (process.platform !== 'win32') native.GIT_CONFIG_SYSTEM = '/etc/gitconfig';
  return native;
}

function windowsLibgit2Configs(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') return [];
  const homeDrivePath = env.HOMEDRIVE && env.HOMEPATH ? env.HOMEDRIVE + env.HOMEPATH : undefined;
  const configured = (path: string | undefined): path is string => Boolean(path);
  const homes = [env.HOME, homeDrivePath, env.USERPROFILE].filter(configured);
  const appData = [env.PROGRAMDATA, env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME].filter(configured);
  return [
    ...homes.flatMap(home => [join(home, '.gitconfig'), join(home, '.config', 'git', 'config')]),
    ...appData.map(dir => join(dir, 'git', 'config'))
  ];
}

function rewriteError(location: string): Error {
  return new Error(`MAA 资源同步已暂停：Git 配置将官方地址重写。请检查 ${location} 的 url.*.insteadOf 规则，确保拉取 ${OFFICIAL_RESOURCE_GIT_URL}`);
}

async function readGitConfig(args: string[], context: GitContext): Promise<string> {
  try {
    return await runResourceGitProbe([...args, '--includes', '--show-origin', '--null', '--list'], context);
  } catch (error) {
    const hint = error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? '请安装系统 Git 后重试'
      : '请检查系统 Git 及其配置后重试';
    throw new Error(`无法核验 MAA 资源同步使用的 Git 配置。${hint}。`, { cause: error });
  }
}

async function checkGitConfig(
  context: GitContext,
  args: string[],
  inspectConditionalIncludes: boolean,
  visited = new Set<string>()
): Promise<void> {
  const result = await readGitConfig(args, context);
  const fields = result.split('\0');
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const origin = fields[index];
    const entry = fields[index + 1];
    const separator = entry.indexOf('\n');
    const key = separator === -1 ? entry : entry.slice(0, separator);
    const value = separator === -1 ? '' : entry.slice(separator + 1);

    if (key.startsWith('url.') && key.endsWith('.insteadof') && OFFICIAL_RESOURCE_GIT_URL.startsWith(value)) {
      const target = key.slice(4, -'.insteadof'.length) + OFFICIAL_RESOURCE_GIT_URL.slice(value.length);
      if (target !== OFFICIAL_RESOURCE_GIT_URL) throw rewriteError(origin || context.cwd);
    }
    if (key === 'remote.origin.url' && value !== OFFICIAL_RESOURCE_GIT_URL) {
      throw new Error(`MAA 资源同步已暂停：请修正 ${origin || context.cwd} 中的 remote.origin.url，使用 ${OFFICIAL_RESOURCE_GIT_URL}`);
    }
    if (key === 'remote.origin.vcs' && value) {
      throw new Error(`MAA 资源同步已暂停：请移除 ${origin || context.cwd} 中的 remote.origin.vcs，以使用官方 HTTPS 仓库`);
    }

    if (inspectConditionalIncludes && key.startsWith('includeif.') && key.endsWith('.path') && value) {
      const base = origin.startsWith('file:') ? dirname(resolve(context.cwd, origin.slice(5))) : context.cwd;
      const include = value.startsWith('~') || value.startsWith('%(prefix)')
        ? await runResourceGitProbe(['-c', `la-pluma.include=${value}`, 'config', '--type=path', '--get', 'la-pluma.include'], context)
          .then(path => path.replace(/\r?\n$/, ''))
        : value;
      const path = resolve(base, include);
      await checkConfigFile(path, context, true, visited);
    }
  }
}

async function checkConfigFile(path: string, context: GitContext, conditional: boolean, visited: Set<string>): Promise<void> {
  if (visited.has(path)) return;
  visited.add(path);
  try {
    await stat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return;
    throw error;
  }
  await checkGitConfig(context, ['config', '--file', path], conditional, visited);
}

function restrictGitTransport(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const restrictions = [
    "'clone.defaultRemoteName'='origin'",
    "'http.followRedirects'='false'",
    `'http.${OFFICIAL_RESOURCE_GIT_URL}.followRedirects'='false'`,
    "'fetch.recurseSubmodules'='false'",
    "'submodule.recurse'='false'"
  ];
  return {
    ...env,
    GIT_ALLOW_PROTOCOL: 'https',
    GIT_TEMPLATE_DIR: '',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_PARAMETERS: [env.GIT_CONFIG_PARAMETERS, ...restrictions].filter(Boolean).join(' ')
  };
}

export async function prepareResourceGitEnvironment(
  command: string,
  cliPath: string,
  env: NodeJS.ProcessEnv,
  cwd = process.cwd()
): Promise<NodeJS.ProcessEnv> {
  const automatic = AUTO_UPDATE_COMMANDS.has(command);
  if (!automatic && !EXPLICIT_UPDATE_COMMANDS.has(command)) return env;

  const gitEnv = resourceGitEnv(env);
  const update = await inspectResourceGitUpdate({ cliPath, env: gitEnv, cwd, automatic });
  if (!update) return env;

  const gitCwd = update.hasCheckout ? update.checkoutPath : cwd;
  const gitContext = { env: gitEnv, cwd: gitCwd };
  const gitDir = update.hasCheckout ? [] : ['--git-dir', join(cwd, `.la-pluma-git-${randomUUID()}`)];
  const nativeContext = { env: libgit2Env(gitEnv), cwd: gitCwd };
  const clone = !update.hasCheckout;
  await checkGitConfig(gitContext, [...gitDir, 'config'], clone);
  const visitedNativeConfigs = new Set<string>();
  await checkGitConfig(nativeContext, [...gitDir, 'config'], clone, visitedNativeConfigs);
  for (const path of windowsLibgit2Configs(nativeContext.env)) {
    await checkConfigFile(path, nativeContext, clone, visitedNativeConfigs);
  }

  if (update.backend === 'git') {
    const args = update.hasCheckout
      ? ['remote', 'get-url', '--all', 'origin']
      : [...gitDir, 'ls-remote', '--get-url', '--', OFFICIAL_RESOURCE_GIT_URL];
    const effective = await runResourceGitProbe(args, gitContext);
    const urls = effective.replace(/\r?\n$/, '').split(/\r?\n/);
    if (urls.some(url => url !== OFFICIAL_RESOURCE_GIT_URL)) throw rewriteError(gitCwd);
  }

  return restrictGitTransport(gitEnv);
}
