import { describe, expect, it } from 'vitest'
import type { AgentRun } from '@/features/task-execution'
import {
  describeRoguelikeRunSummary,
  readRoguelikeRunSummary,
  type RoguelikeRunSummary,
} from './runSummary'

function summary(overrides: Partial<RoguelikeRunSummary> = {}): RoguelikeRunSummary {
  return {
    command: 'roguelike',
    theme: 'Phantom',
    status: 'success',
    observed: true,
    message: '肉鸽结算：第 5 层 · 得分 1200',
    settlement: {
      gamePass: true,
      floor: 5,
      step: 42,
      combat: 12,
      recruit: 8,
      collection: 21,
      boss: 2,
      emergency: 3,
      difficulty: 9,
      score: 1200,
      exp: 320,
      skill: '后勤分队',
    },
    investment: {
      rounds: 2,
      count: 30,
      total: 600,
      deposit: 300,
      reachedLimit: false,
      reachedFull: false,
    },
    events: [{ name: '不期而遇', option: '迎战' }],
    coppers: [{ toDiscard: '破损铜钱', toPickup: '完整铜钱' }],
    milestones: ['深入调查已完成'],
    warnings: ['已达本次投资上限'],
    strategy: { profile: '稳扎稳打', outcome: '获胜', succeeded: true },
    combats: 6,
    taskChain: { started: true, completed: true, failed: false, stopped: false },
    ...overrides,
  }
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run-1',
    operationId: 'run_task',
    state: 'succeeded',
    result: { summary: summary() },
    links: { self: '/api/agent/runs/run-1' },
    ...overrides,
  }
}

describe('readRoguelikeRunSummary', () => {
  it('returns null without a run', () => {
    expect(readRoguelikeRunSummary(null)).toBeNull()
  })

  it('reads the structured summary attached to a successful result', () => {
    const parsed = readRoguelikeRunSummary(run())

    expect(parsed).toEqual(summary())
  })

  it('falls back to the error details summary of a failed run', () => {
    const errorSummary = summary({ status: 'failed', message: '集成战略执行失败：连接中断' })
    const parsed = readRoguelikeRunSummary(run({
      state: 'failed',
      result: undefined,
      error: { code: 'AGENT_RUN_FAILED', message: '执行失败', details: { summary: errorSummary } },
    }))

    expect(parsed?.status).toBe('failed')
    expect(parsed?.message).toBe('集成战略执行失败：连接中断')
  })

  it('prefers the result summary over the error summary', () => {
    const parsed = readRoguelikeRunSummary(run({
      state: 'stopped',
      result: { summary: summary({ status: 'stopped', message: '集成战略任务已停止' }) },
      error: { details: { summary: summary({ status: 'failed' }) } },
    }))

    expect(parsed?.status).toBe('stopped')
  })

  it('returns null instead of exposing unparsed error text', () => {
    const parsed = readRoguelikeRunSummary(run({
      state: 'failed',
      result: 'MaaCore 进程异常退出',
      error: { message: '设备连接中断', details: { summary: '无法连接设备' } },
    }))

    expect(parsed).toBeNull()
  })

  it.each([
    ['unknown command', { command: 'combat' }],
    ['unknown status', { status: 'done' }],
    ['missing settlement', { settlement: undefined }],
    ['bad settlement field', { settlement: { ...(summary().settlement ?? {}), floor: '5' } }],
    ['bad investment', { investment: { rounds: 1 } }],
    ['bad events', { events: [{ name: '事件', option: 3 }] }],
    ['bad coppers', { coppers: [{ toDiscard: 'a' }] }],
    ['bad milestones', { milestones: 'milestone' }],
    ['bad strategy', { strategy: { profile: 'x', outcome: null, succeeded: 'yes' } }],
    ['bad taskChain', { taskChain: { started: true } }],
    ['bad combats', { combats: 'six' }],
  ])('rejects a summary with %s', (_label, patch) => {
    expect(readRoguelikeRunSummary(run({ result: { summary: { ...summary(), ...patch } } }))).toBeNull()
  })

  it('accepts null settlement, investment and strategy', () => {
    const parsed = readRoguelikeRunSummary(run({
      result: {
        summary: summary({ settlement: null, investment: null, strategy: null }),
      },
    }))

    expect(parsed?.settlement).toBeNull()
    expect(parsed?.investment).toBeNull()
    expect(parsed?.strategy).toBeNull()
  })
})

describe('describeRoguelikeRunSummary', () => {
  it('labels success and converts every recorded fact into readable lines', () => {
    const description = describeRoguelikeRunSummary(summary())

    expect(description.statusLabel).toBe('成功')
    expect(description.tone).toBe('success')
    expect(description.metrics).toEqual(expect.arrayContaining([
      { label: '主题', value: 'Phantom' },
      { label: '通关', value: '是' },
      { label: '层数', value: '5' },
      { label: '得分', value: '1200' },
      { label: '投资轮次', value: '2' },
      { label: '投资存款', value: '300' },
      { label: '战斗次数', value: '6' },
    ]))
    expect(description.events).toEqual(['不期而遇：迎战'])
    expect(description.notes).toEqual([
      '里程碑：深入调查已完成',
      '警告：已达本次投资上限',
      '通宝交换：丢弃 破损铜钱，拾取 完整铜钱',
      '策略：稳扎稳打 · 获胜',
    ])
  })

  it('maps every terminal status to its label and tone', () => {
    expect(describeRoguelikeRunSummary(summary({ status: 'failed' }))).toMatchObject({
      statusLabel: '失败',
      tone: 'danger',
    })
    expect(describeRoguelikeRunSummary(summary({ status: 'stopped' }))).toMatchObject({
      statusLabel: '已停止',
      tone: 'warning',
    })
    expect(describeRoguelikeRunSummary(summary({ status: 'incomplete' }))).toMatchObject({
      statusLabel: '未完成',
      tone: 'warning',
    })
  })

  it('omits missing nullable facts instead of printing placeholders', () => {
    const description = describeRoguelikeRunSummary(summary({
      theme: '',
      settlement: null,
      investment: null,
      events: [],
      coppers: [],
      milestones: [],
      warnings: [],
      strategy: null,
      combats: 0,
    }))

    expect(description.metrics).toEqual([{ label: '战斗次数', value: '0' }])
    expect(description.events).toEqual([])
    expect(description.notes).toEqual([])
  })

  it('describes an unlabeled event and a boolean-only strategy outcome', () => {
    const description = describeRoguelikeRunSummary(summary({
      events: [{ name: '紧急作战', option: null }],
      strategy: { profile: null, outcome: null, succeeded: false },
    }))

    expect(description.events).toEqual(['紧急作战（未记录选项）'])
    expect(description.notes).toContain('策略：失败')
  })
})
