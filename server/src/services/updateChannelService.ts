import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import TOML from '@iarna/toml';
import { updateTextFile } from '../utils/fileHelper.ts';
import { getMaaConfigDir } from './maaConfigService.ts';

export const CORE_UPDATE_CHANNELS = ['stable', 'beta', 'alpha'] as const;
export type CoreUpdateChannel = (typeof CORE_UPDATE_CHANNELS)[number];

export const CLI_UPDATE_CHANNELS = ['stable', 'beta', 'nightly'] as const;
export type CliUpdateChannel = (typeof CLI_UPDATE_CHANNELS)[number];

export type UpdateChannelScope = 'core' | 'cli';

export interface UpdateChannels {
  core: CoreUpdateChannel;
  cli: CliUpdateChannel;
}

export interface CliUpdateCapabilities {
  binary: boolean;
}

type ChannelDocument = Record<string, unknown>;

const stringifyToml = TOML.stringify as (document: ChannelDocument) => string;

const CORE_CHANNEL_LABELS: Record<CoreUpdateChannel, string> = {
  stable: 'Stable',
  beta: 'Beta',
  alpha: 'Alpha'
};

const CLI_CHANNEL_LABELS: Record<CliUpdateChannel, string> = {
  stable: 'Stable',
  beta: 'Beta',
  nightly: 'Nightly'
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCoreUpdateChannel(value: unknown): value is CoreUpdateChannel {
  return typeof value === 'string' && (CORE_UPDATE_CHANNELS as readonly string[]).includes(value);
}

export function isCliUpdateChannel(value: unknown): value is CliUpdateChannel {
  return typeof value === 'string' && (CLI_UPDATE_CHANNELS as readonly string[]).includes(value);
}

function normalizeCoreChannel(value: unknown): CoreUpdateChannel {
  if (typeof value !== 'string') return 'stable';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'alpha' || normalized === 'nightly') return 'alpha';
  return isCoreUpdateChannel(normalized) ? normalized : 'stable';
}

function normalizeCliChannel(value: unknown): CliUpdateChannel {
  if (typeof value !== 'string') return 'stable';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'alpha' || normalized === 'nightly') return 'nightly';
  return isCliUpdateChannel(normalized) ? normalized : 'stable';
}

async function resolveCliConfigPath(): Promise<string> {
  const configDir = await getMaaConfigDir();
  return resolve(configDir.trim(), 'cli.toml');
}

async function readChannelDocument(path: string): Promise<ChannelDocument> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch {
    return {};
  }
  const parsed: unknown = TOML.parse(content);
  return isRecord(parsed) ? parsed : {};
}

function section(document: ChannelDocument, key: string): ChannelDocument {
  const value = document[key];
  if (value == null) return {};
  if (!isRecord(value)) throw new TypeError(`cli.toml 的 [${key}] section 格式不合法`);
  return value;
}

export async function readUpdateChannels(): Promise<UpdateChannels> {
  try {
    const document = await readChannelDocument(await resolveCliConfigPath());
    return {
      core: normalizeCoreChannel(section(document, 'core').channel),
      cli: normalizeCliChannel(section(document, 'cli').channel)
    };
  } catch {
    return { core: 'stable', cli: 'stable' };
  }
}

export async function readCliUpdateCapabilities(): Promise<CliUpdateCapabilities> {
  try {
    const document = await readChannelDocument(await resolveCliConfigPath());
    const components = section(section(document, 'cli'), 'components');
    return { binary: components.binary !== false };
  } catch {
    return { binary: true };
  }
}

export async function saveUpdateChannel(scope: UpdateChannelScope, channel: unknown): Promise<UpdateChannels> {
  if (scope === 'core' && !isCoreUpdateChannel(channel)) {
    throw new TypeError('核心更新渠道不合法');
  }
  if (scope === 'cli' && !isCliUpdateChannel(channel)) {
    throw new TypeError('CLI 更新渠道不合法');
  }
  const path = await resolveCliConfigPath();
  await updateTextFile(path, current => {
    const document = current === null ? {} : readChannelDocumentText(current);
    if (scope === 'core') {
      document.core = {
        ...section(document, 'core'),
        channel: CORE_CHANNEL_LABELS[channel as CoreUpdateChannel]
      };
    } else {
      const cli = { ...section(document, 'cli') };
      cli.channel = CLI_CHANNEL_LABELS[channel as CliUpdateChannel];
      document.cli = cli;
    }
    return stringifyToml(document);
  });
  return readUpdateChannels();
}

function readChannelDocumentText(content: string): ChannelDocument {
  const parsed: unknown = TOML.parse(content);
  if (!isRecord(parsed)) throw new TypeError('cli.toml 格式不合法');
  return parsed;
}
