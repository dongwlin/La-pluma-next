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
    })
    expect(award.paramFields.every(field => field.type === 'checkbox')).toBe(true)
    expect(award.taskType).toBe('Award')
  })

  it('keeps the switch keys, their order and the defaults', () => {
    if (!award) throw new Error('missing award task')

    expect(award.paramFields.map(field => field.key))
      .toEqual(['award', 'mail', 'recruit', 'orundum', 'mining', 'specialaccess'])
    expect(award.defaultParams).toEqual({
      award: true,
      mail: true,
      recruit: false,
      orundum: false,
      mining: false,
      specialaccess: false,
    })
  })

  it('explains what the limited-banner pull and the anniversary card actually claim', () => {
    if (!award) throw new Error('missing award task')
    const helperOf = (key: string) =>
      award.paramFields.find(field => field.key === key)?.helper ?? ''

    expect(helperOf('recruit')).toContain('限定池赠送的每日免费单抽')
    expect(helperOf('specialaccess')).toContain('周年活动赠送的月卡奖励')

    const labels = award.paramFields.map(field => field.label).join('')
    expect(labels).not.toContain('公招')
    expect(labels).not.toContain('特别登录')
    expect(labels).not.toContain('通行证')
  })
})

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
      .toEqual(['-1', '0', '1', '2', '3', '4', '5', '6'])
    expect(series.visibleWhen).toBeUndefined()
    expect(series.hiddenWhen).toBeUndefined()
    expect(Object.keys(series)).not.toContain('disabled')
  })
})
