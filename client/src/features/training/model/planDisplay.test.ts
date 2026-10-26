import { describe, expect, it } from 'vitest'
import type { TrainingPlan, TrainingQueueItem } from '../types'
import {
  getOpenStageCount,
  getOpenStagePlan,
  getPlanFocusName,
  selectTodayStages,
  summarizeTodayPlan,
} from './planDisplay'

const plan = (overrides: Partial<TrainingPlan> = {}): TrainingPlan => ({
  mode: 'current',
  stages: [
    { stage: '1-7', totalTimes: 5, sanityPerRun: 6, isOpen: true },
    { stage: 'CA-5', totalTimes: 2, sanityPerRun: 18, isOpen: false },
  ],
  openStages: [{ stage: '1-7', totalTimes: 5 }],
  closedStages: [{ stage: 'CA-5', totalTimes: 2, isOpen: false }],
  totalSanity: 30,
  ...overrides,
})

const queueItem = (name: string): TrainingQueueItem => ({
  operatorId: 'char_current',
  operator: { name, rarity: 6, profession: 'SNIPER' },
  currentElite: 1,
  targetElite: 2,
  materials: [],
  progress: 0,
})

describe('training plan display', () => {
  it('prefers the server open-stage projection, including an explicit empty list', () => {
    expect(getOpenStagePlan(plan()).stages).toEqual([{ stage: '1-7', totalTimes: 5 }])
    expect(getOpenStagePlan(plan({
      openStages: [],
      stages: [{ stage: '1-7', totalTimes: 5, isOpen: true }],
    })).stages).toEqual([])
  })

  it('falls back to stages that are not explicitly closed', () => {
    const fallback = plan({
      openStages: undefined,
      stages: [
        { stage: '1-7', totalTimes: 5, isOpen: true },
        { stage: 'CE-6', totalTimes: 1 },
        { stage: 'CA-5', totalTimes: 2, isOpen: false },
      ],
    })

    expect(getOpenStagePlan(fallback).stages?.map(stage => stage.stage)).toEqual(['1-7', 'CE-6'])
    expect(selectTodayStages(fallback).map(stage => stage.stage)).toEqual(['1-7', 'CE-6'])
  })

  it('counts open stages from the same projection and returns zero without a plan', () => {
    expect(getOpenStageCount(null)).toBe(0)
    expect(getOpenStageCount(plan())).toBe(1)
    expect(getOpenStageCount(plan({ openStages: undefined }))).toBe(1)
    expect(getOpenStageCount(plan({ openStages: undefined, stages: [] }))).toBe(0)
  })

  it('summarizes today runs and sanity by looking up full stage metadata', () => {
    const summary = summarizeTodayPlan(plan({
      openStages: [
        { stage: '1-7', totalTimes: 5 },
        { stage: 'CE-6', totalTimes: 3 },
      ],
      stages: [
        { stage: '1-7', totalTimes: 5, sanityPerRun: 6, isOpen: true },
        { stage: 'CE-6', totalTimes: 3, sanityPerRun: 30, isOpen: true },
      ],
    }))

    expect(summary.stages.map(stage => stage.stage)).toEqual(['1-7', 'CE-6'])
    expect(summary.openStageCount).toBe(2)
    expect(summary.runCount).toBe(8)
    expect(summary.sanity).toBe(5 * 6 + 3 * 30)
  })

  it('treats missing run counts and sanity metadata as zero', () => {
    const summary = summarizeTodayPlan(plan({
      openStages: [{ stage: '1-7' }],
      stages: [{ stage: '1-7', isOpen: true }],
    }))

    expect(summary.runCount).toBe(0)
    expect(summary.sanity).toBe(0)
    expect(summarizeTodayPlan(null)).toEqual({
      stages: [],
      openStageCount: 0,
      runCount: 0,
      sanity: 0,
    })
  })

  it('derives the focus name from the plan, then the queue target', () => {
    expect(getPlanFocusName(plan({ focusOperator: { id: 'a', name: '阿米娅', rarity: 6 } }), queueItem('能天使')))
      .toBe('阿米娅')
    expect(getPlanFocusName(plan({
      focusOperator: null,
      operators: [{ id: 'b', name: '艾雅法拉', rarity: 6, currentElite: 1, targetElite: 2 }],
    }), queueItem('能天使'))).toBe('艾雅法拉')
    expect(getPlanFocusName(null, queueItem('能天使'))).toBe('能天使')
    expect(getPlanFocusName(null, null)).toBe('未设置')
  })
})
