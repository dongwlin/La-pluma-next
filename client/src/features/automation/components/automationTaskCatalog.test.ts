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

describe('automation closedown task catalog', () => {
  const closedown = AVAILABLE_TASKS.find(task => task.id === 'closedown')

  it('adds operator recognition next to the depot recognition switch', () => {
    if (!closedown) throw new Error('missing closedown task')

    expect(closedown.defaultParams).toEqual({
      clientType: 'Official',
      recognizeDepotBeforeClose: false,
      recognizeOperBoxBeforeClose: false,
    })
    expect(closedown.paramFields.map(field => field.key)).toEqual([
      'clientType',
      'recognizeDepotBeforeClose',
      'recognizeOperBoxBeforeClose',
    ])
    expect(closedown.paramFields.find(field => field.key === 'recognizeOperBoxBeforeClose')).toMatchObject({
      label: '关闭前识别干员',
      type: 'checkbox',
    })
  })

  it('keeps the two recognition switches without a helper line', () => {
    if (!closedown) throw new Error('missing closedown task')

    const switches = closedown.paramFields.filter(field => field.type === 'checkbox')

    expect(switches.map(field => [field.key, field.label])).toEqual([
      ['recognizeDepotBeforeClose', '关闭前识别仓库'],
      ['recognizeOperBoxBeforeClose', '关闭前识别干员'],
    ])
    expect(switches.every(field => field.helper === undefined)).toBe(true)
  })
})

describe('automation task parameter defaults and copy', () => {
  it('uses expiry days for the fight medicine and keeps the legacy key out of the catalog', () => {
    const fight = AVAILABLE_TASKS.find(task => task.id === 'fight')
    expect(fight?.defaultParams).toMatchObject({ medicineExpireDays: 0 })
    expect(fight?.defaultParams).not.toHaveProperty('expiringMedicine')

    const medicine = fightParamField('medicineExpireDays')
    expect(medicine.label).toContain('天数')
    expect(medicine.helper).toContain('0 表示不使用临期药')
  })

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
  })

  it('moves the two startup helper texts into tooltips without touching the copy', () => {
    const startup = AVAILABLE_TASKS.find(task => task.id === 'startup')
    const accountName = startup?.paramFields.find(field => field.key === 'accountName')
    const launchSwitch = startup?.paramFields.find(field => field.key === 'start_game_enabled')

    expect(accountName?.helper).toBe('输入已登录账号的部分字符即可，如 "123****4567" 可输入 "4567"')
    expect(launchSwitch?.helper).toBe('关闭后只连接设备并进入已有游戏的主界面，不会启动游戏客户端')
    expect(accountName?.helperPlacement).toBe('tooltip')
    expect(launchSwitch?.helperPlacement).toBe('tooltip')
  })

  it('moves the recruit helper texts into tooltips without touching the copy', () => {
    const recruit = AVAILABLE_TASKS.find(task => task.id === 'recruit')
    if (!recruit) throw new Error('missing recruit task')
    const fieldOf = (key: string) => recruit.paramFields.find(field => field.key === key)

    expect(fieldOf('force_refresh')).toMatchObject({
      label: '无许可时仍刷新',
      helper: '招聘许可耗尽后，仍会使用可用刷新次数',
      helperPlacement: 'tooltip',
    })
    expect(fieldOf('select')).toMatchObject({
      label: '招募星级',
      helper: '支持 6 星自动公招；勾选 6 星后会保留高价值标签并自动选择对应组合',
      helperPlacement: 'tooltip',
    })
    expect(fieldOf('confirm')).toMatchObject({
      label: '确认星级',
      helper: '建议至少保留 5/6 星确认，避免高价值标签被跳过；不勾选任何星级时只计算标签，不会确认招募',
      helperPlacement: 'tooltip',
    })
    expect(fieldOf('times')).toMatchObject({
      label: '招募次数',
      helper: '设为 0 时只计算标签，不执行招募',
      helperPlacement: 'tooltip',
    })
    expect(fieldOf('preserve_tags')).toMatchObject({
      label: '保留标签',
      helper: '识别到任一标签时保留该公招槽位，多个标签用逗号分隔',
      helperPlacement: 'tooltip',
    })
    expect(fieldOf('level3_recruitment_permit_reserve')).toMatchObject({
      label: '3 星保留招聘许可',
      helper: '自动确认 3 星时保留的招聘许可数量；剩余许可小于等于该值时跳过 3 星招募，0 表示不保留',
      helperPlacement: 'tooltip',
    })
  })

  it('keeps the default inline helper placement for every other field', () => {
    const fields = AVAILABLE_TASKS.flatMap(task => task.paramFields)
    const tooltipHelpers = fields
      .filter(field => field.helperPlacement === 'tooltip')
      .map(field => field.key)

    expect(tooltipHelpers).toEqual([
      'accountName',
      'start_game_enabled',
      'force_refresh',
      'select',
      'confirm',
      'times',
      'preserve_tags',
      'level3_recruitment_permit_reserve',
    ])
    expect(fields.find(field => field.key === 'medicineExpireDays')?.helperPlacement).toBeUndefined()
    expect(fields.find(field => field.key === 'series')?.helperPlacement).toBeUndefined()
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
      .toEqual(['-1', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
    expect(series.visibleWhen).toBeUndefined()
    expect(series.hiddenWhen).toBeUndefined()
    expect(Object.keys(series)).not.toContain('disabled')
  })
})
