import { describe, expect, it } from 'vitest'
import {
  OPER_PROGRESS_ROLES,
  resolveOperProgressRole,
  updateOperProgressMastery,
  updateOperProgressTarget,
  validateFightMedicineExpireDays,
  validateFightSeries,
  validateOperProgressPlans,
  validateRecruitExtraTagsMode,
  validateRecruitPermitReserve,
  validateThemes,
} from './gameTaskParams'
import { findTaskFlowValidationFailure, type TaskFlowEntry } from './taskFlowCommands'

const task = (taskType: string, params: TaskFlowEntry['params'], enabled = true): TaskFlowEntry => ({
  id: 'game-task-1',
  commandId: taskType === 'OperProgress' ? 'operprogress' : 'switchtheme',
  name: '游戏任务',
  description: '',
  defaultParams: {},
  params,
  taskType,
  enabled,
})

describe('game task parameter validation', () => {
  it('accepts an omitted profession for Core name-based inference', () => {
    expect(validateOperProgressPlans([{ name: '阿米娅', elite: 2 }])).toBeNull()
  })

  it('maps game-data professions onto the Core role identifiers', () => {
    for (const { value: role } of OPER_PROGRESS_ROLES) {
      expect(resolveOperProgressRole(role.toUpperCase())).toBe(role)
    }
    expect(resolveOperProgressRole('CASTER')).toBe('Caster')
    expect(resolveOperProgressRole('  warrior ')).toBe('Warrior')
    expect(resolveOperProgressRole('未知')).toBe('Unknown')
    expect(resolveOperProgressRole(undefined)).toBe('Unknown')
  })

  it('accepts each supported profession with combined explicit targets', () => {
    for (const { value: role } of OPER_PROGRESS_ROLES) {
      expect(validateOperProgressPlans([{ role, name: '阿米娅', elite: 2, skill_level: 7, skill_mastery: [0, 2, 3] }])).toBeNull()
    }
  })

  it.each([
    [[], '添加至少一项'],
    [[{ role: 'Caster', name: '  ', elite: 2 }], '填写干员姓名'],
    [[{ role: 'Drone', name: '阿米娅', elite: 2 }], '有效职业'],
    [[{ role: 'Caster', name: '阿米娅', elite: 0 }], '精英目标'],
    [[{ role: 'Caster', name: '阿米娅', skill_level: 8 }], '技能等级'],
    [[{ role: 'Caster', name: '阿米娅', skill_level: 2.5 }], '技能等级'],
    [[{ role: 'Caster', name: '阿米娅', skill_mastery: [1, 2] }], '专精目标'],
    [[{ role: 'Caster', name: '阿米娅', skill_mastery: [0, 0, 4] }], '专精目标'],
    [[{ role: 'Caster', name: '阿米娅', skill_mastery: [0, 0, 0] }], '至少选择一个'],
    [[{ role: 'Caster', name: '阿米娅' }], '至少选择一个'],
  ])('rejects invalid cultivation plans', (plans, message) => {
    expect(validateOperProgressPlans(plans)).toContain(message)
  })

  it('validates every plan and selects the invalid task before execution', () => {
    const plans = [{ role: 'Medic', name: '闪灵', skill_level: 7 }, { role: 'Caster', name: '', elite: 2 }]
    const failure = findTaskFlowValidationFailure([task('OperProgress', { plans })])
    expect(failure).toEqual({ taskId: 'game-task-1', message: '培养计划 2：请填写干员姓名' })
    expect(findTaskFlowValidationFailure([task('OperProgress', { plans }, false)])).toBeNull()
  })

  it('requires a nonempty theme list without blank or non-string entries', () => {
    expect(validateThemes(['明日方舟', ' 新主题 '])).toBeNull()
    for (const themes of [undefined, [], [''], ['明日方舟', '  '], [123]]) {
      expect(validateThemes(themes)).toContain('主题名')
    }
    expect(findTaskFlowValidationFailure([task('SwitchTheme', { themes: [] })])?.taskId).toBe('game-task-1')
  })

  it('removes unselected goals and leaves the original plan intact', () => {
    const plan = { role: 'Caster', name: '阿米娅', elite: 2 }
    expect(updateOperProgressTarget(plan, 'elite', '')).toEqual({ role: 'Caster', name: '阿米娅' })
    expect(updateOperProgressTarget(plan, 'skill_level', '7')).toEqual({ ...plan, skill_level: 7 })
    const mastery = updateOperProgressMastery(plan, 1, '3')
    expect(mastery).toEqual({ ...plan, skill_mastery: [0, 3, 0] })
    expect(updateOperProgressMastery(mastery, 1, '0')).toEqual(plan)
    expect(plan).toEqual({ role: 'Caster', name: '阿米娅', elite: 2 })
  })
})


describe('daily task parameter validation', () => {
  it('accepts the fight series range and rejects values outside it', () => {
    for (const value of [-1, 0, 1, 10, '5', '', undefined]) {
      expect(validateFightSeries(value)).toBeNull()
    }
    expect(validateFightSeries(11)).toContain('连战倍率')
    expect(validateFightSeries('-2')).toContain('连战倍率')
    expect(validateFightSeries('abc')).toContain('连战倍率')
  })

  it('accepts zero expiry days and rejects negative values', () => {
    expect(validateFightMedicineExpireDays(0)).toBeNull()
    expect(validateFightMedicineExpireDays('2')).toBeNull()
    expect(validateFightMedicineExpireDays(-1)).toContain('临期药天数')
    expect(validateRecruitPermitReserve(0)).toBeNull()
    expect(validateRecruitPermitReserve(8)).toBeNull()
    expect(validateRecruitPermitReserve(-1)).toContain('保留招聘许可')
    expect(validateRecruitExtraTagsMode(0)).toBeNull()
    expect(validateRecruitExtraTagsMode(2)).toBeNull()
    expect(validateRecruitExtraTagsMode(3)).toContain('策略')
  })
})
