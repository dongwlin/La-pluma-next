import { describe, expect, it } from 'vitest'
import type { GameTaskDetail } from './automationRun'
import {
  describeDeferredMastery,
  describeGameTaskDetail,
  gameTaskResultDetailLabel,
  gameTaskResultLabel,
  gameTaskRoleLabel,
} from './gameTaskResultText'

const detail = (overrides: Partial<GameTaskDetail> = {}): GameTaskDetail => ({
  name: '阿米娅',
  result: 'Success',
  resultDetail: 'Completed',
  ...overrides,
})

describe('game task result text', () => {
  it.each([
    ['ResourceInsufficient', '材料不足'],
    ['OperatorNotFound', '未找到干员'],
    ['TrainingRoomBusy', '训练室已被占用'],
    ['PrerequisiteTraining', '已启动前置专精训练'],
    ['AlreadySatisfied', '已达到目标'],
    ['Completed', '已完成'],
    ['PrerequisiteNotMet', '前置条件未满足'],
    ['ChipNotCraftable', '无法合成芯片'],
    ['FormulaLocked', '配方未解锁'],
    ['RecognitionFailed', '识别失败'],
    ['Unsupported', '不支持的计划'],
    ['Interrupt', '已中断'],
  ])('labels the %s result detail', (resultDetail, label) => {
    expect(gameTaskResultDetailLabel(resultDetail)).toBe(label)
  })

  it('falls back to the raw token for unknown result details and omits empty ones', () => {
    expect(gameTaskResultDetailLabel('FutureResult')).toBe('FutureResult')
    expect(gameTaskResultDetailLabel('')).toBeUndefined()
  })

  it('maps action results', () => {
    expect(gameTaskResultLabel('Success')).toBe('培养成功')
    expect(gameTaskResultLabel('Failed')).toBe('培养失败')
    expect(gameTaskResultLabel('Skipped')).toBe('已跳过')
  })

  it('omits absent and Unknown roles', () => {
    expect(gameTaskRoleLabel()).toBeUndefined()
    expect(gameTaskRoleLabel('Unknown')).toBeUndefined()
    expect(gameTaskRoleLabel('Caster')).toBe('术师')
    expect(describeGameTaskDetail(detail({ role: 'Unknown' }))).toBe('阿米娅：培养成功 · 已完成')
  })

  it('keeps a detail without reason or target free of dangling separators', () => {
    expect(describeGameTaskDetail({ name: '陈', result: 'Failed', resultDetail: '' }))
      .toBe('陈：培养失败')
    expect(describeGameTaskDetail({ name: '陈', role: 'Warrior', result: 'Skipped', resultDetail: 'Interrupt' }))
      .toBe('陈（近卫）：已跳过 · 已中断')
  })

  it('describes a detail with its result, reason and target summary', () => {
    expect(describeGameTaskDetail(detail({
      role: 'Caster',
      result: 'Failed',
      resultDetail: 'ResourceInsufficient',
      elite: 2,
      skillLevel: 7,
      skillMastery: [0, 2, 0],
    }))).toBe('阿米娅（术师）：培养失败 · 材料不足 · 精英二 / 技能 7 / 专精 S2 Lv2')
  })

  it('describes deferred mastery targets with their mastery summary', () => {
    expect(describeDeferredMastery({ name: '白面鸮', role: 'Medic', skillMastery: [0, 0, 2] }))
      .toBe('白面鸮（医疗）：专精目标待处理，本轮已启动其他专精训练 · 专精 S3 Lv2')
  })
})
