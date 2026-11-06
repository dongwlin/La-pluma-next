// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '@/shared/api'
import { createQueryClient } from '@/shared/query'
import {
  DEFAULT_MIRRORCHYAN_CHECK_INTERVAL,
  DEFAULT_RESOURCE_GIT_URL,
  DEFAULT_RESOURCE_SOURCE_DRAFT,
  ResourceSourceOwner,
  buildResourceSourcePayload,
  normalizeResourceSourceDraft,
  resourceSourceQueryOptions,
  type ResourceSourceOwnerOptions,
} from './resourceSource'
import { settingsKeys } from './queryKeys'

const apiMocks = vi.hoisted(() => ({
  getResourceSource: vi.fn(),
  saveResourceSource: vi.fn(),
}))

vi.mock('../api', () => ({
  getResourceSource: apiMocks.getResourceSource,
  saveResourceSource: apiMocks.saveResourceSource,
}))

type WriteRequest = NonNullable<ResourceSourceOwnerOptions['write']>

const createOwner = (write?: WriteRequest) => (
  new ResourceSourceOwner(write ? { write } : {})
)

const serverView = (overrides: Record<string, unknown> = {}) => ({
  autoUpdate: true,
  warnOnUpdateFailure: false,
  source: 'mirrorchyan',
  git: {
    backend: 'git',
    url: DEFAULT_RESOURCE_GIT_URL,
    branch: null,
    useSshAgent: false,
    sshKey: null,
    passphraseKind: 'none',
  },
  mirrorchyan: { cdkKind: 'plain', checkInterval: 1800 },
  ...overrides,
})

describe('resource source normalization', () => {
  it('maps the server view into a draft without echoing credentials', () => {
    const draft = normalizeResourceSourceDraft(serverView())

    expect(draft).toEqual({
      autoUpdate: true,
      warnOnUpdateFailure: false,
      source: 'mirrorchyan',
      git: {
        backend: 'git',
        url: DEFAULT_RESOURCE_GIT_URL,
        branch: '',
        useSshAgent: false,
        sshKey: '',
        passphrase: '',
        passphraseKind: 'none',
      },
      mirrorchyan: { cdk: '', cdkKind: 'plain', clearCdk: false, checkInterval: 1800 },
    })
  })

  it('falls back to defaults for invalid fields and rejects non-objects', () => {
    const draft = normalizeResourceSourceDraft({
      autoUpdate: 'yes',
      source: 'git',
      git: { backend: 'hg', url: '', branch: null, useSshAgent: 'no', sshKey: 42 },
      mirrorchyan: { cdkKind: 'unknown', checkInterval: -1 },
    })

    expect(draft).toMatchObject({
      autoUpdate: false,
      source: 'git',
      git: { backend: 'git', url: DEFAULT_RESOURCE_GIT_URL, useSshAgent: false, sshKey: '' },
      mirrorchyan: { cdkKind: 'none', checkInterval: DEFAULT_MIRRORCHYAN_CHECK_INTERVAL },
    })
    expect(normalizeResourceSourceDraft(null)).toBeNull()
    expect(normalizeResourceSourceDraft({ source: 'ftp' })).toBeNull()
    expect(normalizeResourceSourceDraft({ source: 'git', git: {}, mirrorchyan: {} })).toMatchObject({
      source: 'git',
    })
  })

  it('omits blank secrets and empty optional fields from the save payload', () => {
    const payload = buildResourceSourcePayload(DEFAULT_RESOURCE_SOURCE_DRAFT)

    expect(payload).toEqual({
      autoUpdate: false,
      warnOnUpdateFailure: false,
      source: 'git',
      git: {
        backend: 'git',
        url: DEFAULT_RESOURCE_GIT_URL,
        branch: null,
        useSshAgent: false,
        sshKey: null,
      },
      mirrorchyan: { checkInterval: DEFAULT_MIRRORCHYAN_CHECK_INTERVAL },
    })
  })

  it('sends typed credentials and the explicit clear flag', () => {
    const payload = buildResourceSourcePayload({
      ...DEFAULT_RESOURCE_SOURCE_DRAFT,
      source: 'mirrorchyan',
      git: {
        ...DEFAULT_RESOURCE_SOURCE_DRAFT.git,
        branch: ' dev ',
        passphrase: ' secret ',
      },
      mirrorchyan: { cdk: ' cdk-value ', cdkKind: 'plain', clearCdk: true, checkInterval: 0 },
    })

    expect(payload).toMatchObject({
      git: { branch: 'dev', passphrase: 'secret' },
      mirrorchyan: { cdk: 'cdk-value', clearCdk: true, checkInterval: 0 },
    })
  })
})

describe('resource source owner', () => {
  beforeEach(() => {
    apiMocks.getResourceSource.mockReset()
    apiMocks.saveResourceSource.mockReset()
  })

  it('starts from the documented defaults', () => {
    const owner = createOwner()

    expect(owner.getState()).toMatchObject({
      draft: DEFAULT_RESOURCE_SOURCE_DRAFT,
      dirty: false,
      loaded: false,
    })
  })

  it('tracks nested edits and detects a restore to the persisted value', () => {
    const owner = createOwner()
    const token = owner.beginRead()
    owner.adoptServer({ config: normalizeResourceSourceDraft(serverView())!, readToken: token })

    expect(owner.update({
      mirrorchyan: { ...owner.getState().draft.mirrorchyan, checkInterval: 60 },
    })).toBe(true)
    expect(owner.getState().dirty).toBe(true)
    expect(owner.restoreDefaults()).toBe(true)
    expect(owner.getState().draft).toEqual(DEFAULT_RESOURCE_SOURCE_DRAFT)
  })

  it('saves through the resource source endpoint and keeps nested values intact', async () => {
    apiMocks.saveResourceSource.mockResolvedValue({ success: true })
    const owner = createOwner()
    owner.update({ autoUpdate: true })

    await expect(owner.save()).resolves.toMatchObject({ status: 'saved', superseded: false })
    expect(apiMocks.saveResourceSource).toHaveBeenCalledWith(expect.objectContaining({
      autoUpdate: true,
      source: 'git',
    }))
    expect(owner.getState().dirty).toBe(false)
  })

  it('keeps the draft on failure', async () => {
    apiMocks.saveResourceSource.mockResolvedValue({ success: false, message: '配置目录只读' })
    const owner = createOwner()
    owner.update({ warnOnUpdateFailure: true })

    await expect(owner.save()).resolves.toMatchObject({ status: 'failed', message: '配置目录只读' })
    expect(owner.getState()).toMatchObject({ syncState: 'failed', dirty: true })
  })

  it('drops a late read that started before an edit', () => {
    const owner = createOwner()
    const token = owner.beginRead()
    owner.update({ autoUpdate: true })

    expect(owner.adoptServer({
      config: normalizeResourceSourceDraft(serverView())!,
      readToken: token,
    })).toBe(false)
    expect(owner.getState().draft.autoUpdate).toBe(true)
  })
})

describe('resource source query', () => {
  beforeEach(() => {
    apiMocks.getResourceSource.mockReset()
  })

  it('uses the reserved resource-source key and forwards the signal', async () => {
    apiMocks.getResourceSource.mockResolvedValue({ success: true, data: serverView() })
    const owner = createOwner()
    const options = resourceSourceQueryOptions(owner)

    expect(options.queryKey).toEqual(settingsKeys.query('resource-source'))
    expect(options.queryKey).toEqual(['settings', 'resource-source'])

    const data = await createQueryClient().fetchQuery(options)

    expect(apiMocks.getResourceSource).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(data.config.mirrorchyan.cdkKind).toBe('plain')
  })

  it('turns an unusable payload into a contract failure', async () => {
    apiMocks.getResourceSource.mockResolvedValue({ success: true, data: 'not-a-source' })

    const error = await createQueryClient()
      .fetchQuery(resourceSourceQueryOptions(createOwner()))
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({ kind: 'contract', code: 'INVALID_DOMAIN_PAYLOAD' })
  })
})
