import { execFile } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_MAA_CLI_PATH } from '../config/connectionDefaults.ts';
import type { CliUpdateChannel } from './updateChannelService.ts';

const execFileAsync = promisify(execFile);

export type CliInstallSource = 'standalone' | 'homebrew' | 'winget' | 'container';

export interface CliUpdaterPlan {
  source: CliInstallSource;
  channel: CliUpdateChannel;
  command: string;
  args: string[];
  supported: boolean;
  reason?: string;
}

export interface CliUpdaterOptions {
  cliPath?: string;
  env?: NodeJS.ProcessEnv;
  binaryEnabled?: boolean;
  force?: boolean;
  resolveExecutable?: (command: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
}

export interface CliUpdaterResult {
  stdout: string;
  stderr: string;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutable(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (isAbsolute(command)) {
    try {
      return await realpath(command);
    } catch {
      return await isExecutable(command) ? command : null;
    }
  }
  if (command.includes('/') || command.includes('\\')) {
    return await isExecutable(command) ? command : null;
  }
  const pathValue = env.PATH || '';
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (await isExecutable(candidate)) {
      try {
        return await realpath(candidate);
      } catch {
        return candidate;
      }
    }
  }
  return null;
}

function homebrewPlan(channel: CliUpdateChannel): CliUpdaterPlan {
  if (channel === 'nightly') {
    return {
      source: 'homebrew',
      channel,
      command: 'brew',
      args: ['upgrade', 'maa-cli'],
      supported: false,
      reason: 'Homebrew 没有 Nightly 渠道的 maa-cli 公式'
    };
  }
  return {
    source: 'homebrew',
    channel,
    command: 'brew',
    args: ['upgrade', channel === 'beta' ? 'maa-cli-beta' : 'maa-cli'],
    supported: true
  };
}

function wingetPlan(channel: CliUpdateChannel): CliUpdaterPlan {
  if (channel !== 'stable') {
    return {
      source: 'winget',
      channel,
      command: 'winget',
      args: ['upgrade', 'maa-cli'],
      supported: false,
      reason: 'winget 只提供 maa-cli 的 Stable 渠道'
    };
  }
  return {
    source: 'winget',
    channel,
    command: 'winget',
    args: ['upgrade', 'maa-cli'],
    supported: true
  };
}

function selfUpdatePlan(
  source: CliInstallSource,
  path: string,
  channel: CliUpdateChannel,
  force: boolean,
  binaryEnabled: boolean
): CliUpdaterPlan {
  if (!binaryEnabled) {
    return {
      source,
      channel,
      command: path,
      args: ['self', 'update'],
      supported: false,
      reason: 'cli.toml 已禁用 maa-cli 的 binary 组件'
    };
  }
  return {
    source,
    channel,
    command: path,
    args: ['self', 'update', channel, ...(force ? ['--force'] : [])],
    supported: true
  };
}

export async function resolveCliInstallSource(
  options: Pick<CliUpdaterOptions, 'cliPath' | 'env' | 'resolveExecutable'> = {}
): Promise<{ source: CliInstallSource; path: string } | null> {
  const env = options.env ?? process.env;
  const cliPath = options.cliPath ?? DEFAULT_MAA_CLI_PATH;
  const resolve = options.resolveExecutable ?? resolveExecutable;
  const resolved = await resolve(cliPath, env).catch(() => null);
  if (!resolved) return null;

  const normalized = resolved.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/cellar/')) return { source: 'homebrew', path: resolved };
  if (normalized.includes('/winget/packages/')) return { source: 'winget', path: resolved };
  if ((env.DOCKER_ENV || '').trim() && normalized.startsWith('/opt/maa-cli/')) {
    return { source: 'container', path: resolved };
  }
  return { source: 'standalone', path: resolved };
}

export async function buildCliUpdaterPlan(
  channel: CliUpdateChannel,
  options: CliUpdaterOptions = {}
): Promise<CliUpdaterPlan> {
  const detected = await resolveCliInstallSource(options);
  if (!detected) {
    return {
      source: 'standalone',
      channel,
      command: options.cliPath ?? DEFAULT_MAA_CLI_PATH,
      args: ['self', 'update', channel],
      supported: false,
      reason: '找不到 maa CLI 可执行文件'
    };
  }

  const force = options.force === true;
  if (detected.source === 'homebrew') return homebrewPlan(channel);
  if (detected.source === 'winget') return wingetPlan(channel);
  return selfUpdatePlan(
    detected.source,
    detected.path,
    channel,
    force,
    options.binaryEnabled !== false
  );
}

export async function runCliUpdater(plan: CliUpdaterPlan): Promise<CliUpdaterResult> {
  if (!plan.supported) throw new Error(plan.reason || '当前安装来源不支持更新 MAA CLI');
  const { stdout, stderr } = await execFileAsync(plan.command, plan.args);
  return { stdout, stderr };
}
