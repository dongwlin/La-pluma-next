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

describe('automation fight task catalog', () => {
  it('explains that stage times and the series multiplier apply together', () => {
    const stages = fightParamField('stages')
    expect(stages.helper).toContain('累计作战局数上限')
    expect(stages.helper).toContain('连战中的每一局都计 1')
    expect(stages.helper).toContain('留空表示不限制局数')

    const series = fightParamField('series')
    expect(series.helper).toContain('连战倍率')
    expect(series.helper).toContain('与各关卡次数同时生效')
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
