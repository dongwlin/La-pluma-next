// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTOMATION_CONFIG_COMMIT_DELAY_MS,
  AUTOMATION_CONFIG_KEY,
  AUTOMATION_CONFIG_PENDING_KEY,
  AUTOMATION_SCHEDULE_KEY,
  AUTOMATION_TASK_FLOW_KEY,
  activeScheduleTimes,
  automationConfigAdapter,
  createDefaultAutomationDraft,
  createDefaultScheduleEntries,
  type AutomationConfigDraft,
} from './automationConfig'

const mocks = vi.hoisted(() => ({
  loadUserConfig: vi.fn(),
  saveUserConfig: vi.fn(),
  setupSchedule: vi.fn(),
  stopSchedule: vi.fn(),
}))

vi.mock('@/features/user-config', () => ({
  loadUserConfig: mocks.loadUserConfig,
  saveUserConfig: mocks.saveUserConfig,
}))

vi.mock('../api', () => ({
  setupSchedule: mocks.setupSchedule,
  stopSchedule: mocks.stopSchedule,
}))

const taskFlow = [
  {
    id: 'startup-1',
    commandId: 'startup',
    name: '启动游戏',
    description: '启动游戏并进入主界面',
    enabled: true,
    params: { clientType: 'Bilibili', accountName: '' },
  },
  {
    id: 'recruit-1',
    commandId: 'recruit',
    name: '自动公招',
    description: '自动公开招募',
    enabled: true,
    params: { refresh: true, skip_robot: true },
  },
  {
    id: 'closedown-1',
    commandId: 'closedown',
    name: '关闭游戏',
    description: '关闭游戏客户端',
    enabled: true,
    params: {},
  },
]

const draft: AutomationConfigDraft = {
  taskFlow: taskFlow as AutomationConfigDraft['taskFlow'],
  schedule: {
    enabled: true,
    entries: [
      { time: '08:00', enabled: true },
      { time: '14:00', enabled: false },
    ],
  },
}

const taskFlowFixtureForFetch = [
  {
    id: 'startup-1',
    commandId: 'startup',
    name: '启动游戏',
    description: '启动游戏并进入主界面',
    enabled: true,
    params: { clientType: 'Official', accountName: '' },
  },
]

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

beforeEach(() => {
  localStorage.clear()
  mocks.loadUserConfig.mockReset()
  mocks.saveUserConfig.mockReset().mockResolvedValue({ success: true })
  mocks.setupSchedule.mockReset().mockResolvedValue({ success: true })
  mocks.stopSchedule.mockReset().mockResolvedValue({ success: true })
})

describe('automation config adapter', () => {
  it('keeps the original config key, pending key, local keys, and immediate commit policy', () => {
    expect(automationConfigAdapter).toMatchObject({
      key: 'automation-tasks',
      pendingKey: 'automationConfigSyncPending',
      commitDelayMs: 0,
    })
    expect({
      config: AUTOMATION_CONFIG_KEY,
      pending: AUTOMATION_CONFIG_PENDING_KEY,
      taskFlow: AUTOMATION_TASK_FLOW_KEY,
      schedule: AUTOMATION_SCHEDULE_KEY,
      delay: AUTOMATION_CONFIG_COMMIT_DELAY_MS,
    }).toEqual({
      config: 'automation-tasks',
      pending: 'automationConfigSyncPending',
      taskFlow: 'maa-task-flow',
      schedule: 'maa-schedule',
      delay: 0,
    })
  })

  it('encodes only the persisted task fields and enabled schedule times', () => {
    const withUiFields = {
      ...draft,
      taskFlow: draft.taskFlow.map(task => ({
        ...task,
        icon: 'icon-node',
        paramFields: [{ key: 'clientType' }],
      })),
    } as unknown as AutomationConfigDraft

    const wire = automationConfigAdapter.encodeDraft(withUiFields)

    expect(wire.schedule).toEqual({ enabled: true, times: ['08:00'] })
    expect(activeScheduleTimes(draft.schedule.entries)).toEqual(['08:00'])
    expect(wire.taskFlow[0]).not.toHaveProperty('icon')
    expect(wire.taskFlow[0]).not.toHaveProperty('paramFields')
    expect(Object.keys(wire).sort()).toEqual(['schedule', 'taskFlow'])
  })

  it('decodes the server payload with existing migrations, connection sync, and closedown last', () => {
    const decoded = automationConfigAdapter.decodeDraft({
      taskFlow: [
        taskFlow[2],
        taskFlow[0],
        { ...taskFlow[1], params: { refresh: true, skip_robot: true } },
      ],
      schedule: { enabled: true, times: ['08:00', '20:00', '08:00'] },
    })

    expect(decoded).not.toBeNull()
    expect(decoded!.taskFlow.map(task => task.id)).toEqual(['startup-1', 'recruit-1', 'closedown-1'])
    expect(decoded!.taskFlow[1]?.params).toMatchObject({
      refresh: true,
      preserve_tags: '支援机械',
      force_refresh: true,
      first_tags: '',
      extra_tags_mode: 0,
      recruitment_time: { '3': 540, '4': 540 },
    })
    expect(decoded!.taskFlow[1]?.params).not.toHaveProperty('skip_robot')
    // 关闭游戏沿用启动游戏的客户端类型。
    expect(decoded!.taskFlow[2]?.params).toMatchObject({ clientType: 'Bilibili' })
    expect(decoded!.schedule).toEqual({
      enabled: true,
      entries: [
        { time: '08:00', enabled: true },
        { time: '20:00', enabled: true },
      ],
    })
  })

  it('keeps local-only disabled entries and falls back to default times', () => {
    const decoded = automationConfigAdapter.decodeDraft({
      schedule: {
        enabled: false,
        entries: [
          { time: '08:00', enabled: false },
          { time: '14:00', enabled: true },
        ],
      },
    })

    expect(decoded!.schedule).toEqual({
      enabled: false,
      entries: [
        { time: '08:00', enabled: false },
        { time: '14:00', enabled: true },
      ],
    })

    expect(automationConfigAdapter.decodeDraft({ schedule: { enabled: false, times: [] } })!.schedule)
      .toEqual({ enabled: false, entries: createDefaultScheduleEntries() })
    expect(automationConfigAdapter.decodeDraft({})).toEqual(createDefaultAutomationDraft())
  })

  it.each([
    ['a non-object payload', null],
    ['an array payload', []],
    ['a non-array task flow', { taskFlow: {} }],
    ['a task without an id', { taskFlow: [{ name: '启动游戏' }] }],
    ['a task with non-object params', { taskFlow: [{ id: 'startup-1', params: [] }] }],
    ['a task with a non-boolean enabled flag', { taskFlow: [{ id: 'startup-1', enabled: 'yes' }] }],
    ['a non-object schedule', { schedule: [] }],
    ['a non-boolean schedule flag', { schedule: { enabled: 'true' } }],
    ['a non-array times list', { schedule: { times: '08:00' } }],
  ])('rejects %s so the caller can fall back to the local draft', (_label, payload) => {
    expect(automationConfigAdapter.decodeDraft(payload)).toBeNull()
  })

  it('reads and writes the original local draft layout symmetrically', () => {
    automationConfigAdapter.writeLocalDraft(draft)

    expect(JSON.parse(localStorage.getItem(AUTOMATION_TASK_FLOW_KEY) ?? 'null')).toEqual(draft.taskFlow)
    expect(JSON.parse(localStorage.getItem(AUTOMATION_SCHEDULE_KEY) ?? 'null')).toEqual({
      enabled: true,
      times: ['08:00'],
      entries: draft.schedule.entries,
    })
    const read = automationConfigAdapter.readLocalDraft()
    expect(read?.schedule).toEqual(draft.schedule)
    expect(read?.taskFlow.map(task => task.id)).toEqual(draft.taskFlow.map(task => task.id))
    // 读取本地草稿同样执行旧参数迁移。
    expect(read?.taskFlow[1]?.params).toMatchObject({
      preserve_tags: '支援机械',
      recruitment_time: { '3': 540, '4': 540 },
    })
  })

  it('cleans a damaged local key and keeps the readable part', () => {
    localStorage.setItem(AUTOMATION_TASK_FLOW_KEY, '{not-json')
    localStorage.setItem(AUTOMATION_SCHEDULE_KEY, JSON.stringify({ enabled: true, times: ['09:30'] }))

    expect(automationConfigAdapter.readLocalDraft()).toEqual({
      taskFlow: [],
      schedule: { enabled: true, entries: [{ time: '09:30', enabled: true }] },
    })
    expect(localStorage.getItem(AUTOMATION_TASK_FLOW_KEY)).toBeNull()
    expect(localStorage.getItem(AUTOMATION_SCHEDULE_KEY)).not.toBeNull()
  })

  it('returns null when the whole local draft is unusable', () => {
    localStorage.setItem(AUTOMATION_TASK_FLOW_KEY, '{not-json')
    localStorage.setItem(AUTOMATION_SCHEDULE_KEY, '[]')

    expect(automationConfigAdapter.readLocalDraft()).toBeNull()
    expect(localStorage.getItem(AUTOMATION_TASK_FLOW_KEY)).toBeNull()
    expect(localStorage.getItem(AUTOMATION_SCHEDULE_KEY)).toBeNull()
  })

  it('commits the config and the enabled schedule as one unit', async () => {
    const wire = automationConfigAdapter.encodeDraft(draft)

    await expect(automationConfigAdapter.commit(wire)).resolves.toEqual({ ok: true })
    expect(mocks.saveUserConfig).toHaveBeenCalledWith('automation-tasks', {
      taskFlow: wire.taskFlow,
      schedule: { enabled: true, times: ['08:00'] },
    })
    expect(mocks.setupSchedule).toHaveBeenCalledWith('default', ['08:00'], wire.taskFlow)
    expect(mocks.stopSchedule).not.toHaveBeenCalled()
  })

  it('stops the server schedule when disabled or every entry is disabled', async () => {
    const disabledWire = automationConfigAdapter.encodeDraft({
      ...draft,
      schedule: { enabled: false, entries: draft.schedule.entries },
    })
    await automationConfigAdapter.commit(disabledWire)
    expect(mocks.stopSchedule).toHaveBeenLastCalledWith('default')

    const allDisabledWire = automationConfigAdapter.encodeDraft({
      ...draft,
      schedule: {
        enabled: true,
        entries: [
          { time: '08:00', enabled: false },
          { time: '14:00', enabled: false },
        ],
      },
    })
    await automationConfigAdapter.commit(allDisabledWire)
    expect(mocks.setupSchedule).not.toHaveBeenCalled()
    expect(mocks.stopSchedule).toHaveBeenCalledTimes(2)
  })

  it('does not touch the server schedule when the config save fails', async () => {
    mocks.saveUserConfig.mockResolvedValueOnce({ success: false, message: '配置存储暂不可用' })
    const wire = automationConfigAdapter.encodeDraft(draft)

    await expect(automationConfigAdapter.commit(wire))
      .resolves.toEqual({ ok: false, message: '配置存储暂不可用' })
    expect(mocks.setupSchedule).not.toHaveBeenCalled()
    expect(mocks.stopSchedule).not.toHaveBeenCalled()
  })

  it('keeps a schedule failure retryable after the config was saved', async () => {
    mocks.setupSchedule.mockResolvedValueOnce({ success: false, message: '排班设置失败' })
    const wire = automationConfigAdapter.encodeDraft(draft)

    await expect(automationConfigAdapter.commit(wire))
      .resolves.toEqual({ ok: false, message: '排班设置失败' })
    expect(mocks.saveUserConfig).toHaveBeenCalledOnce()
    expect(mocks.setupSchedule).toHaveBeenCalledOnce()
  })

  it('does not apply a stale schedule step when a newer draft appears during the config save', async () => {
    const save = deferred<{ success: boolean }>()
    mocks.saveUserConfig.mockReturnValueOnce(save.promise)
    const wire = automationConfigAdapter.encodeDraft(draft)

    const commit = automationConfigAdapter.commit(wire)
    // 模拟配置保存期间协调器接受了一份更新的草稿。
    automationConfigAdapter.encodeDraft({ ...draft, schedule: { enabled: false, entries: draft.schedule.entries } })
    await Promise.resolve()
    save.resolve({ success: true })

    await expect(commit).resolves.toEqual({ ok: false, message: '配置已更新，本次定时设置未提交' })
    expect(mocks.setupSchedule).not.toHaveBeenCalled()
    expect(mocks.stopSchedule).not.toHaveBeenCalled()
  })

  it('turns transport failures into retryable results', async () => {
    const wire = automationConfigAdapter.encodeDraft(draft)
    mocks.saveUserConfig.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(automationConfigAdapter.commit(wire))
      .resolves.toEqual({ ok: false, message: 'Failed to fetch' })

    mocks.saveUserConfig.mockResolvedValueOnce({ success: true })
    mocks.setupSchedule.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(automationConfigAdapter.commit(wire))
      .resolves.toEqual({ ok: false, message: 'Failed to fetch' })

    mocks.saveUserConfig.mockResolvedValueOnce({ success: true })
    mocks.setupSchedule.mockRejectedValueOnce('offline')
    await expect(automationConfigAdapter.commit(wire))
      .resolves.toEqual({ ok: false, message: '暂时无法连接服务器' })
  })

  it('fetches through the user-config endpoint with the coordinator signal', async () => {
    const controller = new AbortController()
    const payload = { taskFlow: taskFlowFixtureForFetch, schedule: { enabled: true, times: ['08:00'] } }
    mocks.loadUserConfig.mockResolvedValue({ success: true, data: payload })

    await expect(automationConfigAdapter.fetch({ signal: controller.signal }))
      .resolves.toEqual({ ok: true, payload })
    expect(mocks.loadUserConfig).toHaveBeenCalledWith('automation-tasks', controller.signal)
  })

  it('reports load failures without throwing', async () => {
    mocks.loadUserConfig.mockResolvedValueOnce({ success: false, message: '后端不可用' })
    await expect(automationConfigAdapter.fetch({ signal: new AbortController().signal }))
      .resolves.toEqual({ ok: false, message: '后端不可用' })

    mocks.loadUserConfig.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(automationConfigAdapter.fetch({ signal: new AbortController().signal }))
      .resolves.toEqual({ ok: false, message: 'Failed to fetch' })
  })
})
