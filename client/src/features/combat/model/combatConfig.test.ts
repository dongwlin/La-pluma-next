// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMBAT_ADVANCED_PARAMS_KEY,
  COMBAT_AUTO_FORMATION_KEY,
  COMBAT_CONFIG_COMMIT_DELAY_MS,
  COMBAT_CONFIG_KEY,
  COMBAT_CONFIG_PENDING_KEY,
  COMBAT_SET_EXECUTION_MODE_KEY,
  COMBAT_SET_SELECTIONS_KEY,
  COMBAT_TASK_INPUTS_KEY,
  combatConfigAdapter,
  createDefaultCombatDraft,
  normalizeRaidValue,
} from './combatConfig'

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
  taskInputs: { copilot: 'prts://s48990' },
  advancedParams: {
    copilot: { ignoreRequirements: true, loopTimes: '2', executionStrategy: 'stop', raid: 'both' as const },
    ssscopilot: { loopTimes: '1' },
  },
  autoFormation: { copilot: 'off' as const },
  copilotSetExecutionMode: 'manual' as const,
  copilotSetSelections: { '48990': [1, 0] },
}

beforeEach(() => {
  localStorage.clear()
  mocks.loadUserConfig.mockReset()
  mocks.saveUserConfig.mockReset()
})

describe('combat config adapter', () => {
  it('keeps the original config key, pending key, local keys, and 300ms policy', () => {
    expect(combatConfigAdapter).toMatchObject({
      key: 'combat-tasks',
      pendingKey: 'combatConfigSyncPending',
      commitDelayMs: 300,
    })
    expect({
      config: COMBAT_CONFIG_KEY,
      pending: COMBAT_CONFIG_PENDING_KEY,
      inputs: COMBAT_TASK_INPUTS_KEY,
      advanced: COMBAT_ADVANCED_PARAMS_KEY,
      formation: COMBAT_AUTO_FORMATION_KEY,
      mode: COMBAT_SET_EXECUTION_MODE_KEY,
      selections: COMBAT_SET_SELECTIONS_KEY,
      delay: COMBAT_CONFIG_COMMIT_DELAY_MS,
    }).toEqual({
      config: 'combat-tasks',
      pending: 'combatConfigSyncPending',
      inputs: 'combatTaskInputs',
      advanced: 'combatAdvancedParams',
      formation: 'combatAutoFormation',
      mode: 'combatCopilotSetExecutionMode',
      selections: 'combatCopilotSetSelections',
      delay: 300,
    })
  })

  it('encodes only the persisted fields into the existing wire shape', () => {
    const wire = combatConfigAdapter.encodeDraft(draft)

    expect(wire).toEqual(draft)
    expect(Object.keys(wire).sort()).toEqual([
      'advancedParams',
      'autoFormation',
      'copilotSetExecutionMode',
      'copilotSetSelections',
      'taskInputs',
    ])
  })

  it('decodes the server payload and defaults fields that were never saved', () => {
    expect(combatConfigAdapter.decodeDraft({ taskInputs: { copilot: 'prts://1' } })).toEqual({
      ...createDefaultCombatDraft(),
      taskInputs: { copilot: 'prts://1' },
    })
    expect(combatConfigAdapter.decodeDraft({
      autoFormation: { copilot: 'on' },
      copilotSetSelections: { '48990': [0] },
    })).toEqual({
      ...createDefaultCombatDraft(),
      autoFormation: { copilot: 'on' },
      copilotSetSelections: { '48990': [0] },
    })
  })

  it('migrates the legacy app set mode to cli and normalizes the copilot raid value on load', () => {
    const decoded = combatConfigAdapter.decodeDraft({
      taskInputs: { copilot: 'prts://s1' },
      advancedParams: {
        copilot: { ignoreRequirements: true, raid: '1' },
        ssscopilot: { loopTimes: '2' },
      },
      copilotSetExecutionMode: 'app',
    })

    expect(decoded?.copilotSetExecutionMode).toBe('cli')
    expect(decoded?.advancedParams.copilot?.raid).toBe('raid')
    // 只有 copilot 的 raid 有旧值迁移；其它任务的字段原样保留。
    expect(decoded?.advancedParams.ssscopilot?.loopTimes).toBe('2')
  })

  it('maps both legacy and current raid values to the same names', () => {
    expect(normalizeRaidValue('1')).toBe('raid')
    expect(normalizeRaidValue('raid')).toBe('raid')
    expect(normalizeRaidValue('2')).toBe('both')
    expect(normalizeRaidValue('both')).toBe('both')
    expect(normalizeRaidValue(undefined)).toBe('normal')
    expect(normalizeRaidValue('unexpected')).toBe('normal')
  })

  it.each([
    ['a non-object payload', null],
    ['an array payload', [{ taskInputs: {} }]],
    ['a non-string task input', { taskInputs: { copilot: 1 } }],
    ['a non-object advanced section', { advancedParams: { copilot: [] } }],
    ['an unsupported advanced value', { advancedParams: { copilot: { raid: {} } } }],
    ['an unsupported formation mode', { autoFormation: { copilot: 'sometimes' } }],
    ['an unsupported set execution mode', { copilotSetExecutionMode: 'sequential' }],
    ['a non-array selection', { copilotSetSelections: { '48990': 1 } }],
    ['a non-integer selection index', { copilotSetSelections: { '48990': ['0'] } }],
  ])('rejects %s so the caller can fall back to the local draft', (_label, payload) => {
    expect(combatConfigAdapter.decodeDraft(payload)).toBeNull()
  })

  it('reads and writes the original local draft keys symmetrically', () => {
    combatConfigAdapter.writeLocalDraft(draft)

    expect(JSON.parse(localStorage.getItem(COMBAT_TASK_INPUTS_KEY) ?? 'null'))
      .toEqual({ copilot: 'prts://s48990' })
    expect(JSON.parse(localStorage.getItem(COMBAT_ADVANCED_PARAMS_KEY) ?? 'null'))
      .toEqual(draft.advancedParams)
    expect(JSON.parse(localStorage.getItem(COMBAT_AUTO_FORMATION_KEY) ?? 'null'))
      .toEqual({ copilot: 'off' })
    // 执行方式沿用裸字符串布局，不是 JSON。
    expect(localStorage.getItem(COMBAT_SET_EXECUTION_MODE_KEY)).toBe('manual')
    expect(JSON.parse(localStorage.getItem(COMBAT_SET_SELECTIONS_KEY) ?? 'null'))
      .toEqual({ '48990': [1, 0] })
    expect(combatConfigAdapter.readLocalDraft()).toEqual(draft)
  })

  it('migrates the legacy local app mode and raid values when reading', () => {
    localStorage.setItem(COMBAT_TASK_INPUTS_KEY, JSON.stringify({ copilot: 'prts://old' }))
    localStorage.setItem(COMBAT_ADVANCED_PARAMS_KEY, JSON.stringify({ copilot: { raid: '2' } }))
    localStorage.setItem(COMBAT_SET_EXECUTION_MODE_KEY, 'app')

    const restored = combatConfigAdapter.readLocalDraft()

    expect(restored?.copilotSetExecutionMode).toBe('cli')
    expect(restored?.advancedParams.copilot?.raid).toBe('both')
    expect(combatConfigAdapter.readLocalDraft()).not.toBeNull()
  })

  it('drops only the damaged local section and keeps the readable ones', () => {
    localStorage.setItem(COMBAT_TASK_INPUTS_KEY, '{not-json')
    localStorage.setItem(COMBAT_ADVANCED_PARAMS_KEY, JSON.stringify({ copilot: { raid: '1' } }))
    localStorage.setItem(COMBAT_SET_EXECUTION_MODE_KEY, 'manual')

    expect(combatConfigAdapter.readLocalDraft()).toEqual({
      ...createDefaultCombatDraft(),
      advancedParams: { copilot: { raid: 'raid' } },
      copilotSetExecutionMode: 'manual',
    })
    expect(localStorage.getItem(COMBAT_TASK_INPUTS_KEY)).toBeNull()
    expect(localStorage.getItem(COMBAT_ADVANCED_PARAMS_KEY)).not.toBeNull()
  })

  it('returns null and cleans unusable JSON keys when no local section is readable', () => {
    localStorage.setItem(COMBAT_TASK_INPUTS_KEY, '{not-json')
    localStorage.setItem(COMBAT_ADVANCED_PARAMS_KEY, JSON.stringify({ copilot: 'invalid' }))
    localStorage.setItem(COMBAT_AUTO_FORMATION_KEY, JSON.stringify({ copilot: 'sometimes' }))
    localStorage.setItem(COMBAT_SET_SELECTIONS_KEY, JSON.stringify({ '48990': 'invalid' }))

    expect(combatConfigAdapter.readLocalDraft()).toBeNull()
    expect(localStorage.getItem(COMBAT_TASK_INPUTS_KEY)).toBeNull()
    expect(localStorage.getItem(COMBAT_ADVANCED_PARAMS_KEY)).toBeNull()
    expect(localStorage.getItem(COMBAT_AUTO_FORMATION_KEY)).toBeNull()
    expect(localStorage.getItem(COMBAT_SET_SELECTIONS_KEY)).toBeNull()
  })

  it('keeps an invalid raw execution mode out of the draft without deleting other sections', () => {
    localStorage.setItem(COMBAT_TASK_INPUTS_KEY, JSON.stringify({ copilot: 'prts://1' }))
    localStorage.setItem(COMBAT_SET_EXECUTION_MODE_KEY, 'legacy-unknown')

    expect(combatConfigAdapter.readLocalDraft()).toEqual({
      ...createDefaultCombatDraft(),
      taskInputs: { copilot: 'prts://1' },
    })
    expect(localStorage.getItem(COMBAT_SET_EXECUTION_MODE_KEY)).toBe('legacy-unknown')
  })

  it('commits the full draft through the existing user-config endpoint', async () => {
    mocks.saveUserConfig.mockResolvedValue({ success: true })

    await expect(combatConfigAdapter.commit(draft)).resolves.toEqual({ ok: true })
    expect(mocks.saveUserConfig).toHaveBeenCalledWith('combat-tasks', draft)
  })

  it('keeps a server or transport failure retryable', async () => {
    mocks.saveUserConfig.mockResolvedValueOnce({ success: false, message: '保存失败' })
    await expect(combatConfigAdapter.commit(draft))
      .resolves.toEqual({ ok: false, message: '保存失败' })

    mocks.saveUserConfig.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(combatConfigAdapter.commit(draft))
      .resolves.toEqual({ ok: false, message: 'Failed to fetch' })

    mocks.saveUserConfig.mockRejectedValueOnce('offline')
    await expect(combatConfigAdapter.commit(draft))
      .resolves.toEqual({ ok: false, message: '暂时无法连接服务器' })
  })

  it('fetches through the user-config endpoint with the coordinator signal', async () => {
    const controller = new AbortController()
    const payload = draft
    mocks.loadUserConfig.mockResolvedValue({ success: true, data: payload })

    await expect(combatConfigAdapter.fetch({ signal: controller.signal }))
      .resolves.toEqual({ ok: true, payload })
    expect(mocks.loadUserConfig).toHaveBeenCalledWith('combat-tasks', controller.signal)
  })

  it('reports load failures without throwing', async () => {
    mocks.loadUserConfig.mockResolvedValueOnce({ success: false, message: '后端不可用' })
    await expect(combatConfigAdapter.fetch({ signal: new AbortController().signal }))
      .resolves.toEqual({ ok: false, message: '后端不可用' })

    mocks.loadUserConfig.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(combatConfigAdapter.fetch({ signal: new AbortController().signal }))
      .resolves.toEqual({ ok: false, message: 'Failed to fetch' })
  })
})
