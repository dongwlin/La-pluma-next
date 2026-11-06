import {
  isCliConfigRecord,
  readCliConfigDocument,
  updateCliConfigDocument
} from './cliConfigService.ts';
import type { CliConfigDocument } from './cliConfigService.ts';
import { createLogger } from '../utils/logger.ts';

const logger = createLogger('MaaService');

export const CORE_UPDATE_CHANNELS = ['stable', 'beta', 'alpha'] as const;
export type CoreUpdateChannel = (typeof CORE_UPDATE_CHANNELS)[number];

export const CLI_UPDATE_CHANNELS = ['stable', 'beta', 'nightly'] as const;
export type CliUpdateChannel = (typeof CLI_UPDATE_CHANNELS)[number];

export type UpdateChannelScope = 'core' | 'cli';

export interface UpdateChannels {
  core: CoreUpdateChannel;
  cli: CliUpdateChannel;
  degraded?: boolean;
}

export interface CliUpdateCapabilities {
  binary: boolean;
  degraded?: boolean;
}

type ChannelDocument = CliConfigDocument;

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

function section(document: ChannelDocument, key: string): ChannelDocument {
  const value = document[key];
  if (value == null) return {};
  if (!isCliConfigRecord(value)) throw new TypeError(`cli.toml 的 [${key}] section 格式不合法`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readUpdateChannels(): Promise<UpdateChannels> {
  try {
    const document = await readCliConfigDocument();
    return {
      core: normalizeCoreChannel(section(document, 'core').channel),
      cli: normalizeCliChannel(section(document, 'cli').channel)
    };
  } catch (error) {
    logger.error('读取更新渠道配置失败，使用默认渠道', { error: errorMessage(error) });
    return { core: 'stable', cli: 'stable', degraded: true };
  }
}

export async function readCliUpdateCapabilities(): Promise<CliUpdateCapabilities> {
  try {
    const document = await readCliConfigDocument();
    const components = section(section(document, 'cli'), 'components');
    return { binary: components.binary !== false };
  } catch (error) {
    logger.error('读取 CLI 更新组件配置失败，使用默认能力', { error: errorMessage(error) });
    return { binary: true, degraded: true };
  }
}

export async function saveUpdateChannel(scope: UpdateChannelScope, channel: unknown): Promise<UpdateChannels> {
  if (scope === 'core' && !isCoreUpdateChannel(channel)) {
    throw new TypeError('核心更新渠道不合法');
  }
  if (scope === 'cli' && !isCliUpdateChannel(channel)) {
    throw new TypeError('CLI 更新渠道不合法');
  }
  await updateCliConfigDocument(document => {
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
    return document;
  });
  return readUpdateChannels();
}
