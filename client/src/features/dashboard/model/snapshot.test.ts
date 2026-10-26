// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  normalizeDashboardSnapshot,
  type DashboardSnapshotPayloads,
} from './snapshot'

const validPayloads = (): DashboardSnapshotPayloads => ({
  activity: {
    isActive: true,
    code: 'SSS',
    name: '测试活动',
    tip: '活动说明',
    completion: {
      known: true,
      complete: false,
      completedStages: ['SSS-1'],
      totalStages: 3,
    },
  },
  scheduleExecution: {
    isRunning: true,
    taskName: '收取信用',
    message: '正在执行',
    lastResult: {
      successCount: 2,
      failedCount: 1,
      skippedCount: 0,
      durationMs: 61_000,
      actions: [{ task: '收取信用' }],
    },
  },
  trainingQueue: {
    queue: [
      { operator: { name: '能天使' } },
      { name: '艾雅法拉' },
      { operatorName: '银灰' },
      { nickname: '第四位' },
    ],
  },
  todayDrops: [
    { stageName: '1-7', drops: [{ name: '固源岩', count: 4 }] },
    { stageCode: 'CE-6', items: [{ itemName: '龙门币', count: 3 }] },
    { stage: 'AP-5' },
  ],
  openTodayStages: {
    open: [{ stage: 'AP-5', name: '采购凭证' }],
    closed: [{ stage: 'CE-6', name: '龙门币' }],
  },
})

describe('normalizeDashboardSnapshot', () => {
  it('normalizes all five business payloads into one complete snapshot', () => {
    const snapshot = normalizeDashboardSnapshot(validPayloads())

    expect(snapshot).not.toBeNull()
    expect(snapshot?.activitySummary).toEqual({
      available: true,
      code: 'SSS',
      name: '测试活动',
      tip: '活动说明',
      completion: {
        known: true,
        complete: false,
        completedStages: ['SSS-1'],
        totalStages: 3,
      },
    })
    expect(snapshot?.scheduleSummary).toEqual({
      isRunning: true,
      currentTask: '收取信用',
      message: '正在执行',
      lastTask: '收取信用',
      lastResult: '成功 2 · 失败 1 · 61 秒',
    })
    expect(snapshot?.trainingSummary).toEqual({
      count: 4,
      topNames: ['能天使', '艾雅法拉', '银灰'],
    })
    expect(snapshot?.dropSummary).toEqual({
      count: 3,
      recent: [
        { stage: 'AP-5', items: '已记录作战，暂无材料明细' },
        { stage: 'CE-6', items: '龙门币×3' },
        { stage: '1-7', items: '固源岩×4' },
      ],
    })
    expect(snapshot?.openStageSummary).toEqual({
      open: [{ stage: 'AP-5', name: '采购凭证' }],
      closed: [{ stage: 'CE-6', name: '龙门币' }],
    })
  })

  it('keeps the legacy queue array and drops array payload shapes', () => {
    const payloads = validPayloads()
    payloads.trainingQueue = [{ operatorName: '能天使' }]
    payloads.todayDrops = [{ stageName: '1-7', drops: [{ name: '固源岩', count: 4 }] }]

    const snapshot = normalizeDashboardSnapshot(payloads)

    expect(snapshot?.trainingSummary).toEqual({ count: 1, topNames: ['能天使'] })
    expect(snapshot?.dropSummary).toEqual({
      count: 1,
      recent: [{ stage: '1-7', items: '固源岩×4' }],
    })
  })

  it('accepts alternative activity and schedule fields', () => {
    const payloads = validPayloads()
    payloads.activity = { available: false, id: 'act-1', displayName: '备用活动', description: '备用说明' }
    payloads.scheduleExecution = {
      running: true,
      currentTask: '备用任务',
      status: '状态说明',
      lastTask: '上次任务',
      lastResult: '上次结果',
    }

    const snapshot = normalizeDashboardSnapshot(payloads)

    expect(snapshot?.activitySummary).toEqual({
      available: true,
      code: 'act-1',
      name: '备用活动',
      tip: '备用说明',
      completion: undefined,
    })
    expect(snapshot?.scheduleSummary).toEqual({
      isRunning: true,
      currentTask: '备用任务',
      message: '状态说明',
      lastTask: '上次任务',
      lastResult: '上次结果',
    })
  })

  it('does not treat the backend probe as part of the five business payloads', () => {
    // 归一函数只接收五路业务载荷；探针结果不会进入快照，也不会让快照失效。
    const snapshot = normalizeDashboardSnapshot(validPayloads())
    expect(snapshot).not.toBeNull()
  })

  it.each([
    ['activity is missing', { activity: undefined }],
    ['activity is not a record', { activity: 'ok' }],
    ['activity completion is malformed', { activity: { completion: { totalStages: 1.5 } } }],
    ['activity completion has non-string stages', { activity: { completion: { completedStages: ['A', 1] } } }],
    ['training queue is not an array', { trainingQueue: { queue: 'none' } }],
    ['training queue item is not a record', { trainingQueue: { queue: ['能天使'] } }],
    ['today drops is neither array nor records envelope', { todayDrops: { records: null } }],
    ['today drops item is not a record', { todayDrops: [null] }],
    ['open stages are missing', { openTodayStages: { open: [] } }],
    ['closed stages item has no name', { openTodayStages: { open: [], closed: [{ stage: 'CE-6' }] } }],
    ['schedule execution is not a record', { scheduleExecution: 42 }],
  ])('returns null when %s', (_label, override) => {
    expect(normalizeDashboardSnapshot({ ...validPayloads(), ...override })).toBeNull()
  })

  it('rejects stage summaries beyond the historical bound', () => {
    const payloads = validPayloads()
    payloads.openTodayStages = {
      open: Array.from({ length: 101 }, (_, index) => ({ stage: `S-${index}`, name: '关卡' })),
      closed: [],
    }

    expect(normalizeDashboardSnapshot(payloads)).toBeNull()
  })

  it('prefers drop name fields before the placeholder text', () => {
    const payloads = validPayloads()
    payloads.todayDrops = [
      { stageName: '1-7', itemName: '固源岩' },
      { stageName: '1-7', items: [{ name: '装置', count: 0 }] },
      { stageName: '1-7', items: 'bad-shape' },
    ]

    expect(normalizeDashboardSnapshot(payloads)?.dropSummary.recent).toEqual([
      { stage: '1-7', items: '已记录作战，暂无材料明细' },
      { stage: '1-7', items: '装置×1' },
      { stage: '1-7', items: '固源岩' },
    ])
  })
})
