/**
 * MAA 资源源配置（`cli.toml` 的 `[resource]`）：Git 与 MirrorChyan 两种来源，
 * 以及自动更新与失败告警开关。读取兼容旧版 `backend`/`remote` 写法；保存只写
 * maa-cli 0.7 的 `[resource.source]` 新格式并迁移旧字段。凭据只报告形态，
 * 不回传明文；请求未提供时保留已保存的凭据。
 */
import { agentError } from '../utils/apiHelper.ts';
import type { AgentError } from '../utils/apiHelper.ts';
import {
  isCliConfigRecord,
  readCliConfigDocument,
  updateCliConfigDocument
} from './cliConfigService.ts';
import type { CliConfigDocument } from './cliConfigService.ts';

export const RESOURCE_SOURCE_TYPES = ['git', 'mirrorchyan'] as const;
export type ResourceSourceType = (typeof RESOURCE_SOURCE_TYPES)[number];

export const GIT_BACKENDS = ['git', 'libgit2'] as const;
export type GitBackend = (typeof GIT_BACKENDS)[number];

export const DEFAULT_RESOURCE_GIT_URL = 'https://github.com/MaaAssistantArknights/MaaResource.git';
export const DEFAULT_MIRRORCHYAN_CHECK_INTERVAL = 600;

/** maa-cli Secret 的形态：`false` / `true` / 明文字符串 / `{ env }` / `{ cmd }`。 */
export type ResourceSecretKind = 'none' | 'prompt' | 'plain' | 'env' | 'command';

export interface ResourceGitSource {
  backend: GitBackend;
  url: string;
  branch: string | null;
  useSshAgent: boolean;
  sshKey: string | null;
  passphraseKind: ResourceSecretKind;
}

export interface ResourceMirrorChyanSource {
  cdkKind: ResourceSecretKind;
  checkInterval: number;
}

export interface ResourceSourceConfig {
  autoUpdate: boolean;
  warnOnUpdateFailure: boolean;
  source: ResourceSourceType;
  git: ResourceGitSource;
  mirrorchyan: ResourceMirrorChyanSource;
}

export interface ResourceSourceSaveInput {
  autoUpdate: boolean;
  warnOnUpdateFailure: boolean;
  source: ResourceSourceType;
  git: {
    backend: GitBackend;
    url: string;
    branch: string | null;
    useSshAgent: boolean;
    sshKey: string | null;
    passphrase?: string | null;
  };
  mirrorchyan: {
    checkInterval: number;
    cdk?: string | null;
    clearCdk?: boolean;
  };
}

interface ExistingSourceRaw {
  source: ResourceSourceType;
  git: Record<string, unknown>;
  mirrorchyan: Record<string, unknown>;
}

function invalidResourceSource(field: string, details: Record<string, unknown> = {}): AgentError {
  return agentError('AGENT_RESOURCE_SOURCE_INVALID', '资源源配置不合法', {
    statusCode: 400,
    details: { field, ...details },
    retryable: false
  });
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readSecretKind(value: unknown): ResourceSecretKind {
  if (value === false) return 'none';
  if (value === true) return 'prompt';
  if (typeof value === 'string') return 'plain';
  if (isCliConfigRecord(value)) {
    if (typeof value.env === 'string') return 'env';
    if (Array.isArray(value.cmd)) return 'command';
  }
  return 'none';
}

function readResourceSection(document: CliConfigDocument): Record<string, unknown> {
  const resource = document.resource;
  if (resource == null) return {};
  if (!isCliConfigRecord(resource)) {
    throw new TypeError('cli.toml 的 [resource] section 格式不合法');
  }
  return resource;
}

function readSourceSection(resource: Record<string, unknown>): Record<string, unknown> | null {
  const source = resource.source;
  if (source == null) return null;
  if (!isCliConfigRecord(source)) {
    throw new TypeError('cli.toml 的 [resource.source] section 格式不合法');
  }
  return source;
}

function readGitSource(raw: Record<string, unknown>): ResourceGitSource {
  return {
    backend: raw.backend === 'libgit2' ? 'libgit2' : 'git',
    url: readString(raw.url) ?? DEFAULT_RESOURCE_GIT_URL,
    branch: readString(raw.branch),
    useSshAgent: raw.use_ssh_agent === true,
    sshKey: readString(raw.ssh_key),
    passphraseKind: readSecretKind(raw.passphrase)
  };
}

function readMirrorChyanSource(raw: Record<string, unknown>): ResourceMirrorChyanSource {
  const interval = raw.check_interval;
  return {
    cdkKind: readSecretKind(raw.cdk),
    checkInterval: typeof interval === 'number' && Number.isSafeInteger(interval) && interval >= 0
      ? interval
      : DEFAULT_MIRRORCHYAN_CHECK_INTERVAL
  };
}

function readExistingSourceRaw(resource: Record<string, unknown>): ExistingSourceRaw {
  const source = readSourceSection(resource);
  if (source) {
    const isMirrorChyan = source.type === 'mirrorchyan';
    return {
      source: isMirrorChyan ? 'mirrorchyan' : 'git',
      git: isMirrorChyan ? {} : source,
      mirrorchyan: isMirrorChyan ? source : {}
    };
  }
  const remote = isCliConfigRecord(resource.remote) ? resource.remote : {};
  return {
    source: 'git',
    git: { ...remote, ...(resource.backend === undefined ? {} : { backend: resource.backend }) },
    mirrorchyan: {}
  };
}

/** 把 `cli.toml` 文档投影为资源源视图；缺字段使用 maa-cli 默认值。 */
export function projectResourceSourceConfig(document: CliConfigDocument): ResourceSourceConfig {
  const resource = readResourceSection(document);
  const existing = readExistingSourceRaw(resource);
  return {
    autoUpdate: resource.auto_update === true,
    warnOnUpdateFailure: resource.warn_on_update_failure === true,
    source: existing.source,
    git: readGitSource(existing.git),
    mirrorchyan: readMirrorChyanSource(existing.mirrorchyan)
  };
}

export async function readResourceSourceConfig(): Promise<ResourceSourceConfig> {
  return projectResourceSourceConfig(await readCliConfigDocument());
}

function readRequiredBoolean(source: Record<string, unknown>, key: string, field: string): boolean {
  const value = source[key];
  if (!isBoolean(value)) throw invalidResourceSource(field, { receivedType: typeof value });
  return value;
}

function readOptionalText(source: Record<string, unknown>, key: string, field: string): string | null {
  const value = source[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalidResourceSource(field, { receivedType: typeof value });
  return value.trim() === '' ? null : value;
}

function readGitInput(source: Record<string, unknown>): ResourceSourceSaveInput['git'] {
  const backend = source.backend;
  if (!(GIT_BACKENDS as readonly string[]).includes(String(backend))) {
    throw invalidResourceSource('git.backend', { value: backend });
  }
  const branch = readOptionalText(source, 'branch', 'git.branch');
  const sshKey = readOptionalText(source, 'sshKey', 'git.sshKey');
  const passphrase = readOptionalText(source, 'passphrase', 'git.passphrase');
  const useSshAgent = source.useSshAgent;
  if (!isBoolean(useSshAgent)) {
    throw invalidResourceSource('git.useSshAgent', { receivedType: typeof useSshAgent });
  }
  return {
    backend: backend === 'libgit2' ? 'libgit2' : 'git',
    url: readOptionalText(source, 'url', 'git.url') ?? DEFAULT_RESOURCE_GIT_URL,
    branch,
    useSshAgent,
    sshKey,
    ...(passphrase === null ? {} : { passphrase })
  };
}

function readMirrorChyanInput(source: Record<string, unknown>): ResourceSourceSaveInput['mirrorchyan'] {
  const checkInterval = source.checkInterval;
  if (typeof checkInterval !== 'number' || !Number.isSafeInteger(checkInterval) || checkInterval < 0) {
    throw invalidResourceSource('mirrorchyan.checkInterval', { receivedType: typeof checkInterval });
  }
  const cdk = readOptionalText(source, 'cdk', 'mirrorchyan.cdk');
  const clearCdk = source.clearCdk;
  if (clearCdk !== undefined && !isBoolean(clearCdk)) {
    throw invalidResourceSource('mirrorchyan.clearCdk', { receivedType: typeof clearCdk });
  }
  return {
    checkInterval,
    ...(cdk === null ? {} : { cdk }),
    ...(clearCdk === true ? { clearCdk: true } : {})
  };
}

/** 校验保存请求：字段缺失或类型不符返回 400，凭据值不回显到错误详情。 */
export function parseResourceSourceSaveInput(input: unknown): ResourceSourceSaveInput {
  if (!isCliConfigRecord(input)) {
    throw invalidResourceSource('body', { receivedType: Array.isArray(input) ? 'array' : typeof input });
  }
  const source = input.source;
  if (!(RESOURCE_SOURCE_TYPES as readonly string[]).includes(String(source))) {
    throw invalidResourceSource('source', { value: source });
  }
  if (!isCliConfigRecord(input.git)) {
    throw invalidResourceSource('git', { receivedType: typeof input.git });
  }
  if (!isCliConfigRecord(input.mirrorchyan)) {
    throw invalidResourceSource('mirrorchyan', { receivedType: typeof input.mirrorchyan });
  }
  return {
    autoUpdate: readRequiredBoolean(input, 'autoUpdate', 'autoUpdate'),
    warnOnUpdateFailure: readRequiredBoolean(input, 'warnOnUpdateFailure', 'warnOnUpdateFailure'),
    source: source === 'mirrorchyan' ? 'mirrorchyan' : 'git',
    git: readGitInput(input.git),
    mirrorchyan: readMirrorChyanInput(input.mirrorchyan)
  };
}

function buildCdk(input: ResourceSourceSaveInput['mirrorchyan'], existing: ExistingSourceRaw): unknown {
  if (input.clearCdk === true) return false;
  if (input.cdk) return input.cdk;
  if (existing.source === 'mirrorchyan' && existing.mirrorchyan.cdk !== undefined) {
    return existing.mirrorchyan.cdk;
  }
  return false;
}

function buildGitTable(input: ResourceSourceSaveInput['git'], existing: ExistingSourceRaw): Record<string, unknown> {
  const table: Record<string, unknown> = { type: 'git' };
  if (input.backend === 'libgit2') table.backend = 'libgit2';
  if (input.url !== DEFAULT_RESOURCE_GIT_URL) table.url = input.url;
  if (input.branch) table.branch = input.branch;
  if (input.useSshAgent) table.use_ssh_agent = true;
  if (input.sshKey) table.ssh_key = input.sshKey;
  if (input.passphrase) table.passphrase = input.passphrase;
  else if (existing.source === 'git' && existing.git.passphrase !== undefined) {
    table.passphrase = existing.git.passphrase;
  }
  return table;
}

function buildSourceTable(input: ResourceSourceSaveInput, existing: ExistingSourceRaw): Record<string, unknown> {
  if (input.source === 'mirrorchyan') {
    const table: Record<string, unknown> = {
      type: 'mirrorchyan',
      cdk: buildCdk(input.mirrorchyan, existing)
    };
    if (input.mirrorchyan.checkInterval !== DEFAULT_MIRRORCHYAN_CHECK_INTERVAL) {
      table.check_interval = input.mirrorchyan.checkInterval;
    }
    return table;
  }
  return buildGitTable(input.git, existing);
}

/**
 * 保存资源源配置：只改 `[resource]` 的 source 与共享开关，迁移旧的
 * `backend`/`remote` 写法，其它 section 与未知键原样保留。
 */
export async function saveResourceSourceConfig(input: unknown): Promise<ResourceSourceConfig> {
  const parsed = parseResourceSourceSaveInput(input);
  await updateCliConfigDocument(document => {
    const resource = { ...readResourceSection(document) };
    const existing = readExistingSourceRaw(resource);
    delete resource.backend;
    delete resource.remote;
    resource.auto_update = parsed.autoUpdate;
    resource.warn_on_update_failure = parsed.warnOnUpdateFailure;
    resource.source = buildSourceTable(parsed, existing);
    return { ...document, resource };
  });
  return readResourceSourceConfig();
}
