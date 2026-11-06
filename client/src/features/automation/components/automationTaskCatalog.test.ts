import { describe, expect, it } from 'vitest'
import type { TaskParamField } from '../types'
import { AVAILABLE_TASKS } from './automationTaskCatalog'

function fightParamField(key: string): TaskParamField {
  const fight = AVAILABLE_TASKS.find(task => task.id === 'fight')
  if (!fight) throw new Error('missing fight task')
  const field = fight.paramFields.find(candidate => candidate.key === key)
  if (!field) throw new Error(`missing ${key} field`)
  return field
}

describe('automation award task catalog', () => {
  const award = AVAILABLE_TASKS.find(task => task.id === 'award')

  it('names the limited-banner free pull and the anniversary card reward', () => {
    if (!award) throw new Error('missing award task')
    const labels = Object.fromEntries(award.paramFields.map(field => [field.key, field.label]))

    expect(labels).toEqual({
      award: '日常与周常奖励',
      mail: '邮件奖励',
      recruit: '限定池免费单抽',
      orundum: '合成玉奖励',
      mining: '采矿奖励',
      specialaccess: '周年赠送月卡',
      signinevent: '限时签到活动奖励',
    })
    expect(award.paramFields.every(field => field.type === 'checkbox')).toBe(true)
    expect(award.taskType).toBe('Award')
  })

  it('keeps the switch keys, their order and the defaults', () => {
    if (!award) throw new Error('missing award task')

    expect(award.paramFields.map(field => field.key))
      .toEqual(['award', 'mail', 'recruit', 'orundum', 'mining', 'specialaccess', 'signinevent'])
    expect(award.defaultParams).toEqual({
      award: true,
      mail: true,
      recruit: false,
      orundum: false,
      mining: false,
      specialaccess: false,
      signinevent: false,
    })
  })

  it('explains what the limited-banner pull and the anniversary card actually claim', () => {
    if (!award) throw new Error('missing award task')
    const helperOf = (key: string) =>
      award.paramFields.find(field => field.key === key)?.helper ?? ''

    expect(helperOf('recruit')).toContain('限定池赠送的每日免费单抽')
    expect(helperOf('specialaccess')).toContain('周年活动赠送的月卡奖励')
    expect(helperOf('signinevent')).toContain('限时签到活动')

    const labels = award.paramFields.map(field => field.label).join('')
    expect(labels).not.toContain('公招')
    expect(labels).not.toContain('特别登录')
    expect(labels).not.toContain('通行证')
  })
})

describe('automation game task catalog', () => {
  it('adds dynamic game tasks without preselecting consumptive targets', () => {
    expect(AVAILABLE_TASKS.find(task => task.id === 'operprogress')).toMatchObject({
      name: '游戏内培养', taskType: 'OperProgress', defaultParams: { plans: [] },
    })
    expect(AVAILABLE_TASKS.find(task => task.id === 'switchtheme')).toMatchObject({
      name: '更换游戏主题', taskType: 'SwitchTheme', defaultParams: { themes: [] },
    })
  })
})


  it('uses expiry days for the fight medicine and keeps the legacy key out of the catalog', () => {
    const fight = AVAILABLE_TASKS.find(task => task.id === 'fight')
    expect(fight?.defaultParams).toMatchObject({ medicineExpireDays: 0 })
    expect(fight?.defaultParams).not.toHaveProperty('expiringMedicine')

    const medicine = fightParamField('medicineExpireDays')
    expect(medicine.label).toContain('天数')
    expect(medicine.helper).toContain('0 表示不使用临期药')
  });

  it('adds the recruit permit reserve and the startup launch switch defaults', () => {
    const recruit = AVAILABLE_TASKS.find(task => task.id === 'recruit')
    const permitReserve = recruit?.paramFields.find(field => field.key === 'level3_recruitment_permit_reserve')
    expect(recruit?.defaultParams).toMatchObject({ level3_recruitment_permit_reserve: 0 })
    expect(permitReserve?.label).toBe('3 星保留招聘许可')
    expect(permitReserve?.helper).toContain('0 表示不保留')

    const startup = AVAILABLE_TASKS.find(task => task.id === 'startup')
    const launchSwitch = startup?.paramFields.find(field => field.key === 'start_game_enabled')
    expect(startup?.defaultParams).toMatchObject({ start_game_enabled: true })
    expect(launchSwitch?.label).toBe('启动游戏客户端')
    expect(launchSwitch?.helper).toContain('不会启动游戏客户端')
  });

describe('automation fight task catalog', () => {
  it('explains that stage times and the series multiplier apply together', () => {
    const stages = fightParamField('stages')
    expect(stages.helper).toContain('累计作战局数上限')
    expect(stages.helper).toContain('连战中的每一局都计 1')
    expect(stages.helper).toContain('留空表示不限制局数')

    const series = fightParamField('series')
    expect(series.helper).toContain('连战倍率')
    expect(series.helper).toContain('与各关卡次数同时生效')
    expect(series.helper).toContain('次数少于倍率不会开始任何一局（0 局）')
    expect(series.helper).toContain('不能整除剩余次数时最后一轮连战不会开始')
    expect(series.helper).toContain('实际局数会少于次数')
    expect(series.helper).toContain('自动')
  })

  it('keeps the series options and the default without gating the combination', () => {
    const fight = AVAILABLE_TASKS.find(task => task.id === 'fight')
    expect(fight?.defaultParams.series).toBe('1')

    const series = fightParamField('series')
    expect(series.type).toBe('select')
    expect(series.options?.map(option => (typeof option === 'string' ? option : option.value)))
      .toEqual(['-1', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
    expect(series.visibleWhen).toBeUndefined()
    expect(series.hiddenWhen).toBeUndefined()
    expect(Object.keys(series)).not.toContain('disabled')
  })
})
