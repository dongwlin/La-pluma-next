import { describe, expect, it } from 'vitest'
import type { CopilotSetItem } from '../types'
import {
  buildCopilotDetailTarget,
  collectCopilotItemErrors,
  deriveCopilotDetailState,
  describeCopilotDetailStatus,
  describeCopilotDetailTitle,
  firstErrorLine,
  readMissingDetailCopilotId,
} from './copilotDetail'

const item: CopilotSetItem = {
  id: 101,
  name: '第一关',
  details: '作者：A\nhttps://www.bilibili.com/video/BV1xx411c7mD',
  stage: 'MAIN-1',
  stageId: 'main_01',
  apCost: 21,
  uri: 'prts://101',
  presetFormation: true,
  supportsRaid: false,
  completedModes: ['normal'],
  operatorDetails: [
    { name: '桃金娘', elite: 2, level: 60, skillLevel: 10, module: 'χ' },
  ],
  groupNames: ['击杀组'],
}

describe('describeCopilotDetailTitle', () => {
  it('uses the job title when it differs from the stage', () => {
    expect(describeCopilotDetailTitle(item)).toBe('第一关')
  })

  it('falls back to the job id instead of repeating the stage', () => {
    expect(describeCopilotDetailTitle({ id: 26766, name: '1-7', stage: '1-7' })).toBe('作业 #26766')
    expect(describeCopilotDetailTitle({ id: 26766 })).toBe('作业 #26766')
  })
})

describe('deriveCopilotDetailState', () => {
  it('folds a running item before its already recorded result', () => {
    const state = deriveCopilotDetailState({
      status: 'running',
      runCompleted: true,
      historyCompleted: true,
    })
    expect(state.isCurrent).toBe(true)
    expect(describeCopilotDetailStatus(state)).toBe('执行中')
  })

  it('keeps failure, stopped and skipped states distinct', () => {
    expect(describeCopilotDetailStatus(deriveCopilotDetailState({
      status: 'failed',
      runCompleted: false,
      historyCompleted: false,
    }))).toBe('待重试')
    expect(describeCopilotDetailStatus(deriveCopilotDetailState({
      status: 'stopped',
      runCompleted: false,
      historyCompleted: false,
    }))).toBe('已终止')
    expect(describeCopilotDetailStatus(deriveCopilotDetailState({
      status: 'skipped',
      runCompleted: false,
      historyCompleted: false,
    }))).toBe('已跳过')
  })

  it('only reports historical completion for untouched items', () => {
    expect(describeCopilotDetailStatus(deriveCopilotDetailState({
      status: 'pending',
      runCompleted: false,
      historyCompleted: true,
    }))).toBe('历史已通关')
    expect(describeCopilotDetailStatus(deriveCopilotDetailState({
      status: 'pending',
      runCompleted: false,
      historyCompleted: false,
    }))).toBe('待执行')
    expect(describeCopilotDetailStatus(deriveCopilotDetailState({
      status: 'success',
      runCompleted: true,
      historyCompleted: false,
    }))).toBe('已完成')
  })
})

describe('buildCopilotDetailTarget', () => {
  it('keeps only the facts the queue actually knows', () => {
    expect(buildCopilotDetailTarget({
      copilot: item,
      sourceLabel: '作业集 prts://s48990',
      statusLabel: '待执行',
      error: '缺少干员：桃金娘',
    })).toEqual({
      title: '第一关',
      details: '作者：A\nhttps://www.bilibili.com/video/BV1xx411c7mD',
      stage: 'MAIN-1',
      stageId: 'main_01',
      apCost: 21,
      sourceLabel: '作业集 prts://s48990',
      uri: 'prts://101',
      presetFormation: true,
      supportsRaid: false,
      completedModes: ['normal'],
      operators: [{ name: '桃金娘', elite: 2, level: 60, skillLevel: 10, module: 'χ' }],
      groups: ['击杀组'],
      statusLabel: '待执行',
      error: '缺少干员：桃金娘',
    })
  })

  it('leaves unknown formation, AP and operators out of the target', () => {
    const target = buildCopilotDetailTarget({
      copilot: { id: 102 },
      sourceLabel: '作业集 prts://s48990',
    })

    expect(target).toEqual({
      title: '作业 #102',
      sourceLabel: '作业集 prts://s48990',
      uri: 'prts://102',
    })
    expect(target.presetFormation).toBeUndefined()
    expect(target.operators).toBeUndefined()
    expect(target.error).toBeUndefined()
  })
})

describe('readMissingDetailCopilotId', () => {
  it('returns the copilot id only when a remote single job has no description', () => {
    expect(readMissingDetailCopilotId({ title: '作业', uri: 'prts://101' })).toBe('101')
    expect(readMissingDetailCopilotId({ title: '作业', uri: 'maa://101' })).toBe('101')
    expect(readMissingDetailCopilotId({ title: '作业', uri: 'prts://101', details: '已有' })).toBeNull()
  })

  it('ignores set links, local files and empty targets', () => {
    expect(readMissingDetailCopilotId({ title: '作业集', uri: 'prts://s48990' })).toBeNull()
    expect(readMissingDetailCopilotId({ title: '本地', uri: '/data/a.json' })).toBeNull()
    expect(readMissingDetailCopilotId({ title: '无链接' })).toBeNull()
    expect(readMissingDetailCopilotId(null)).toBeNull()
  })
})

describe('collectCopilotItemErrors', () => {
  it('prefers the terminal summary reason and fills missing entry errors', () => {
    const errors = collectCopilotItemErrors(
      [
        { itemIndex: 0, stage: 'MAIN-1', error: '未知错误' },
        { itemIndex: 1, stage: 'MAIN-2', error: '设备断开' },
      ],
      [
        { itemIndex: 0, stage: 'MAIN-1', error: '缺少干员：桃金娘' },
        { itemIndex: 1, stage: 'MAIN-2', error: '设备断开' },
      ],
    )

    expect(errors.get(0)).toBe('缺少干员：桃金娘')
    expect(errors.get(1)).toBe('设备断开')
  })

  it('skips failures without an item index', () => {
    const errors = collectCopilotItemErrors([
      { itemIndex: null, stage: null, error: '整体失败' },
    ])

    expect(errors.size).toBe(0)
  })
})

describe('firstErrorLine', () => {
  it('returns the first non-empty line for the compact row', () => {
    expect(firstErrorLine('\n缺少干员：桃金娘\n请检查 box')).toBe('缺少干员：桃金娘')
    expect(firstErrorLine('设备断开')).toBe('设备断开')
    expect(firstErrorLine('')).toBeNull()
    expect(firstErrorLine(undefined)).toBeNull()
  })
})
