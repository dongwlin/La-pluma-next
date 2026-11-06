import { queryOptions } from '@tanstack/react-query'
import {
  ApiRequestError,
  isRecord,
  unwrapApiResponse,
  type ApiResponse,
} from '@/shared/api'
import { getResourceSource, saveResourceSource } from '../api'
import type {
  GitBackend,
  ResourceSecretKind,
  ResourceSourceDraft,
} from '../types'
import { ConfigDraftOwner, configValuesEqual } from './configDraftOwner'
import type { ConfigDraftState, ConfigSaveOutcome, ConfigSnapshot } from './configDraftOwner'
import { GIT_BACKENDS, RESOURCE_SOURCE_TYPES } from '../types'
import { settingsKeys } from './queryKeys'

export const OFFICIAL_RESOURCE_GIT_URL = 'https://github.com/MaaAssistantArknights/MaaResource.git'
export const DEFAULT_MIRRORCHYAN_CHECK_INTERVAL = 600

export const DEFAULT_RESOURCE_SOURCE_DRAFT: ResourceSourceDraft = {
  autoUpdate: false,
  warnOnUpdateFailure: false,
  source: 'git',
  git: {
    backend: 'git',
    branch: '',
  },
  mirrorchyan: {
    cdk: '',
    cdkKind: 'none',
    clearCdk: false,
    checkInterval: DEFAULT_MIRRORCHYAN_CHECK_INTERVAL,
  },
}

export type ResourceSourceState = ConfigDraftState<ResourceSourceDraft>

export type ResourceSourceSaveOutcome = ConfigSaveOutcome<ResourceSourceDraft>

export type ResourceSourceSnapshot = ConfigSnapshot<ResourceSourceDraft>

export interface ResourceSourceOwnerOptions {
  readonly write?: (
    profileName: string,
    config: ResourceSourceDraft,
  ) => Promise<ApiResponse<unknown>>
}

const SECRET_KINDS: readonly ResourceSecretKind[] = ['none', 'prompt', 'plain', 'env', 'command']

const isSecretKind = (value: unknown): value is ResourceSecretKind => (
  typeof value === 'string' && (SECRET_KINDS as readonly string[]).includes(value)
)

const isGitBackend = (value: unknown): value is GitBackend => (
  typeof value === 'string' && (GIT_BACKENDS as readonly string[]).includes(value)
)

const isResourceSourceType = (value: unknown): value is ResourceSourceDraft['source'] => (
  typeof value === 'string' && (RESOURCE_SOURCE_TYPES as readonly string[]).includes(value)
)

const isNonNegativeInteger = (value: unknown): value is number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
)

const readText = (value: unknown): string => (typeof value === 'string' ? value : '')

const cloneDraft = (draft: ResourceSourceDraft): ResourceSourceDraft => ({
  ...draft,
  git: { ...draft.git },
  mirrorchyan: { ...draft.mirrorchyan },
})

/**
 * 把服务端资源源视图归一化为页面草稿。已保存的 CDK 只回显形态。
 */
export const normalizeResourceSourceDraft = (value: unknown): ResourceSourceDraft | null => {
  if (!isRecord(value)) return null
  const { git, mirrorchyan } = value
  if (!isRecord(git) || !isRecord(mirrorchyan)) return null
  if (!isResourceSourceType(value.source)) return null

  return {
    autoUpdate: value.autoUpdate === true,
    warnOnUpdateFailure: value.warnOnUpdateFailure === true,
    source: value.source,
    git: {
      backend: isGitBackend(git.backend) ? git.backend : 'git',
      branch: readText(git.branch),
    },
    mirrorchyan: {
      cdk: '',
      cdkKind: isSecretKind(mirrorchyan.cdkKind) ? mirrorchyan.cdkKind : 'none',
      clearCdk: false,
      checkInterval: isNonNegativeInteger(mirrorchyan.checkInterval)
        ? mirrorchyan.checkInterval
        : DEFAULT_MIRRORCHYAN_CHECK_INTERVAL,
    },
  }
}

export const buildResourceSourcePayload = (draft: ResourceSourceDraft): Record<string, unknown> => {
  const cdk = draft.mirrorchyan.cdk.trim()
  const branch = draft.git.branch.trim()
  return {
    autoUpdate: draft.autoUpdate,
    warnOnUpdateFailure: draft.warnOnUpdateFailure,
    source: draft.source,
    git: {
      backend: draft.git.backend,
      branch: branch === '' ? null : branch,
    },
    mirrorchyan: {
      checkInterval: draft.mirrorchyan.checkInterval,
      ...(cdk === '' ? {} : { cdk }),
      ...(draft.mirrorchyan.clearCdk ? { clearCdk: true } : {})
    }
  }
}

export class ResourceSourceOwner extends ConfigDraftOwner<ResourceSourceDraft> {
  constructor(options: ResourceSourceOwnerOptions = {}) {
    super({
      write: options.write ?? ((_profileName, config) => saveResourceSource(buildResourceSourcePayload(config))),
      normalize: normalizeResourceSourceDraft,
      defaultValue: () => cloneDraft(DEFAULT_RESOURCE_SOURCE_DRAFT),
      failureMessage: '保存资源源配置失败',
      clone: cloneDraft,
      equal: configValuesEqual,
    })
  }
}

export const settingsResourceSourceOwner = new ResourceSourceOwner()

export const resourceSourceQueryOptions = (
  owner: ResourceSourceOwner = settingsResourceSourceOwner,
) => queryOptions({
  queryKey: settingsKeys.query('resource-source'),
  queryFn: async ({ signal }): Promise<ResourceSourceSnapshot> => {
    const readToken = owner.beginRead()
    const response = await getResourceSource(signal)
    const config = normalizeResourceSourceDraft(unwrapApiResponse<unknown>(response))
    if (!config) {
      throw new ApiRequestError({
        kind: 'contract',
        code: 'INVALID_DOMAIN_PAYLOAD',
        message: '资源源配置格式不正确',
      })
    }
    return { config, readToken }
  },
})
