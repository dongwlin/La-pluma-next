// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ROGUELIKE_ADVANCED_PARAMS_KEY,
  ROGUELIKE_CONFIG_COMMIT_DELAY_MS,
  ROGUELIKE_CONFIG_KEY,
  ROGUELIKE_CONFIG_PENDING_KEY,
  ROGUELIKE_TASK_INPUTS_KEY,
  roguelikeConfigAdapter,
} from './roguelikeConfig'

const mocks = vi.hoisted(() => ({
  loadUserConfig: vi.fn(),
  saveUserConfig: vi.fn(),
}))

vi.mock('@/features/user-config', () => ({
  USER_CONFIG_KEYS: { combatTasks: 'combat-tasks',
    roguelikeTasks: 'roguelike-tasks',
    automationTasks: 'automation-tasks' },
  USER_CONFIG_PENDING_KEYS: { 'combat-tasks': 'combatConfigSyncPending',
    'roguelike-tasks': 'roguelikeConfigSyncPending',
    'automation-tasks': 'automationConfigSyncPending' },
  loadUserConfig: mocks.loadUserConfig,
  saveUserConfig: mocks.saveUserConfig,
}))

const draft = {
  taskInputs: { roguelike: 'Phantom' },
  advancedParams: { roguelike: { mode: '0', useSupport: true, startCount: 3 } },
}

beforeEach(() => {
  localStorage.clear()
  mocks.loadUserConfig.mockReset()
  mocks.saveUserConfig.mockReset()
})

describe('roguelike config adapter', () => {
  it('keeps the original config key, pending key, local keys, and 300ms policy', () => {
    expect(roguelikeConfigAdapter).toMatchObject({
      key: 'roguelike-tasks',
      pendingKey: 'roguelikeConfigSyncPending',
      commitDelayMs: 300,
    })
    expect({
      config: ROGUELIKE_CONFIG_KEY,
      pending: ROGUELIKE_CONFIG_PENDING_KEY,
      inputs: ROGUELIKE_TASK_INPUTS_KEY,
      advanced: ROGUELIKE_ADVANCED_PARAMS_KEY,
      delay: ROGUELIKE_CONFIG_COMMIT_DELAY_MS,
    }).toEqual({
      config: 'roguelike-tasks',
      pending: 'roguelikeConfigSyncPending',
      inputs: 'roguelikeTaskInputs',
      advanced: 'roguelikeAdvancedParams',
      delay: 300,
    })
  })

  it('encodes only the persisted fields into the existing wire shape', () => {
    const wire = roguelikeConfigAdapter.encodeDraft(draft)

    expect(wire).toEqual({
      taskInputs: { roguelike: 'Phantom' },
      advancedParams: {
        roguelike: { mode: '0', useSupport: true, startCount: 3 },
        reclamation: { mode: '1' },
      },
    })
    expect(Object.keys(wire).sort()).toEqual(['advancedParams', 'taskInputs'])
  })

  it('decodes the server payload and defaults fields that were never saved', () => {
    expect(roguelikeConfigAdapter.decodeDraft({ taskInputs: { roguelike: 'Sami' } }))
      .toEqual({
        taskInputs: { roguelike: 'Sami' },
        advancedParams: { reclamation: { mode: '1' } },
      })
    expect(roguelikeConfigAdapter.decodeDraft({ advancedParams: { roguelike: { mode: '1' } } }))
      .toEqual({
        taskInputs: {},
        advancedParams: { roguelike: { mode: '1' }, reclamation: { mode: '1' } },
      })
  })

  it('fills the reclamation mode when decoding old payloads', () => {
    expect(roguelikeConfigAdapter.decodeDraft({ taskInputs: { reclamation: 'Tales' } }))
      .toEqual({
        taskInputs: { reclamation: 'Tales' },
        advancedParams: { reclamation: { mode: '1' } },
      })
    expect(roguelikeConfigAdapter.decodeDraft({ advancedParams: { reclamation: { mode: '' } } }))
      .toEqual({ taskInputs: {}, advancedParams: { reclamation: { mode: '1' } } })
  })

  it('keeps an explicitly selected reclamation mode while decoding', () => {
    expect(roguelikeConfigAdapter.decodeDraft({
      advancedParams: { reclamation: { mode: '0' } },
    })?.advancedParams.reclamation?.mode).toBe('0')
  })

  it.each([
    ['a non-object payload', null],
    ['an array payload', [{ taskInputs: {} }]],
    ['a non-string task input', { taskInputs: { roguelike: 1 } }],
    ['a non-object advanced section', { advancedParams: { roguelike: [] } }],
    ['an unsupported advanced value', { advancedParams: { roguelike: { mode: {} } } }],
  ])('rejects %s so the caller can fall back to the local draft', (_label, payload) => {
    expect(roguelikeConfigAdapter.decodeDraft(payload)).toBeNull()
  })

  it('reads and writes the original local draft keys symmetrically', () => {
    roguelikeConfigAdapter.writeLocalDraft(draft)

    expect(JSON.parse(localStorage.getItem(ROGUELIKE_TASK_INPUTS_KEY) ?? 'null'))
      .toEqual({ roguelike: 'Phantom' })
    expect(JSON.parse(localStorage.getItem(ROGUELIKE_ADVANCED_PARAMS_KEY) ?? 'null'))
      .toEqual({
        roguelike: { mode: '0', useSupport: true, startCount: 3 },
        reclamation: { mode: '1' },
      })
    expect(roguelikeConfigAdapter.readLocalDraft()).toEqual({
      taskInputs: { roguelike: 'Phantom' },
      advancedParams: {
        roguelike: { mode: '0', useSupport: true, startCount: 3 },
        reclamation: { mode: '1' },
      },
    })
  })

  it('fills the reclamation mode when reading a legacy local draft', () => {
    localStorage.setItem(ROGUELIKE_TASK_INPUTS_KEY, JSON.stringify({ reclamation: 'Tales' }))
    localStorage.setItem(ROGUELIKE_ADVANCED_PARAMS_KEY, JSON.stringify({}))

    expect(roguelikeConfigAdapter.readLocalDraft()).toEqual({
      taskInputs: { reclamation: 'Tales' },
      advancedParams: { reclamation: { mode: '1' } },
    })
  })

  it('keeps an explicitly selected local reclamation mode', () => {
    localStorage.setItem(ROGUELIKE_ADVANCED_PARAMS_KEY, JSON.stringify({
      reclamation: { mode: '0' },
    }))

    expect(roguelikeConfigAdapter.readLocalDraft()?.advancedParams.reclamation?.mode).toBe('0')
  })

  it('drops only the damaged local section and keeps the readable one', () => {
    localStorage.setItem(ROGUELIKE_TASK_INPUTS_KEY, '{not-json')
    localStorage.setItem(ROGUELIKE_ADVANCED_PARAMS_KEY, JSON.stringify({ roguelike: { mode: '1' } }))

    expect(roguelikeConfigAdapter.readLocalDraft()).toEqual({
      taskInputs: {},
      advancedParams: { roguelike: { mode: '1' }, reclamation: { mode: '1' } },
    })
    expect(localStorage.getItem(ROGUELIKE_TASK_INPUTS_KEY)).toBeNull()
    expect(localStorage.getItem(ROGUELIKE_ADVANCED_PARAMS_KEY)).not.toBeNull()
  })

  it('returns null and cleans both keys when the whole local draft is unusable', () => {
    localStorage.setItem(ROGUELIKE_TASK_INPUTS_KEY, '{not-json')
    localStorage.setItem(ROGUELIKE_ADVANCED_PARAMS_KEY, JSON.stringify({ roguelike: 'invalid' }))

    expect(roguelikeConfigAdapter.readLocalDraft()).toBeNull()
    expect(localStorage.getItem(ROGUELIKE_TASK_INPUTS_KEY)).toBeNull()
    expect(localStorage.getItem(ROGUELIKE_ADVANCED_PARAMS_KEY)).toBeNull()
  })

  it('commits the full draft through the existing user-config endpoint', async () => {
    mocks.saveUserConfig.mockResolvedValue({ success: true })

    await expect(roguelikeConfigAdapter.commit(draft)).resolves.toEqual({ ok: true })
    expect(mocks.saveUserConfig).toHaveBeenCalledWith('roguelike-tasks', draft)
  })

  it('keeps a server or transport failure retryable', async () => {
    mocks.saveUserConfig.mockResolvedValueOnce({ success: false, message: '保存失败' })
    await expect(roguelikeConfigAdapter.commit(draft))
      .resolves.toEqual({ ok: false, message: '保存失败' })

    mocks.saveUserConfig.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(roguelikeConfigAdapter.commit(draft))
      .resolves.toEqual({ ok: false, message: 'Failed to fetch' })

    mocks.saveUserConfig.mockRejectedValueOnce('offline')
    await expect(roguelikeConfigAdapter.commit(draft))
      .resolves.toEqual({ ok: false, message: '暂时无法连接服务器' })
  })

  it('fetches through the user-config endpoint with the coordinator signal', async () => {
    const controller = new AbortController()
    const payload = { taskInputs: { roguelike: 'Sami' }, advancedParams: {} }
    mocks.loadUserConfig.mockResolvedValue({ success: true, data: payload })

    await expect(roguelikeConfigAdapter.fetch({ signal: controller.signal }))
      .resolves.toEqual({ ok: true, payload })
    expect(mocks.loadUserConfig).toHaveBeenCalledWith('roguelike-tasks', controller.signal)
  })

  it('reports load failures without throwing', async () => {
    mocks.loadUserConfig.mockResolvedValueOnce({ success: false, message: '后端不可用' })
    await expect(roguelikeConfigAdapter.fetch({ signal: new AbortController().signal }))
      .resolves.toEqual({ ok: false, message: '后端不可用' })

    mocks.loadUserConfig.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(roguelikeConfigAdapter.fetch({ signal: new AbortController().signal }))
      .resolves.toEqual({ ok: false, message: 'Failed to fetch' })
  })
})
