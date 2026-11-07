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

  it('moves the three award helper texts into label tooltips without touching the copy', () => {
    if (!award) throw new Error('missing award task')
    const fieldOf = (key: string) => award.paramFields.find(field => field.key === key)

    expect(fieldOf('recruit')).toMatchObject({
      helper: '活动期间领取限定池赠送的每日免费单抽；没有免费次数时不抽取',
      helperPlacement: 'tooltip',
    })
    expect(fieldOf('specialaccess')).toMatchObject({
      helper: '领取周年活动赠送的月卡奖励',
      helperPlacement: 'tooltip',
    })
    expect(fieldOf('signinevent')).toMatchObject({
      helper: '领取限时签到活动的每日奖励（仅支持常见横向版型）',
      helperPlacement: 'tooltip',
    })

    const tooltipHelpers = award.paramFields
      .filter(field => field.helperPlacement === 'tooltip')
      .map(field => field.key)
    expect(tooltipHelpers).toEqual(['recruit', 'specialaccess', 'signinevent'])

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

  it('keeps the default inline helper placement for every field that still needs one', () => {
    const tooltipHelpers = AVAILABLE_TASKS
      .flatMap(task => task.paramFields)
      .filter(field => field.helperPlacement === 'tooltip')
      .map(field => field.key)

    expect(tooltipHelpers).toEqual([
      'accountName',
      'start_game_enabled',
      'stages',
      'drops',
      'medicine',
      'medicineExpireDays',
      'stone',
      'series',
      'mode',
      'only_buy_discount',
      'reserve_max_credit',
      'credit_fight',
      'recruit',
      'specialaccess',
      'signinevent',
    ])
  })
})

describe('automation infrast task catalog', () => {
  const infrast = AVAILABLE_TASKS.find(task => task.id === 'infrast')

  it('moves the shift mode hint beside the label and drops the facility helper line', () => {
    if (!infrast) throw new Error('missing infrast task')
    const mode = infrast.paramFields.find(field => field.key === 'mode')
    const facility = infrast.paramFields.find(field => field.key === 'facility')

    expect(mode?.helper).toBe('一键轮换使用游戏内队列，并保留无人机、会客室等基础操作')
    expect(mode?.helperPlacement).toBe('tooltip')
    expect(facility?.helper).toBeUndefined()
    expect(facility?.helperPlacement).toBeUndefined()
  })

  it('keeps every facility option and the default selection untouched', () => {
    if (!infrast) throw new Error('missing infrast task')

    expect(infrast.defaultParams.facility).toEqual([
      'Mfg',
      'Trade',
      'Power',
      'Control',
      'Reception',
      'Office',
      'Dorm',
    ])
    expect(infrast.paramFields.map(field => field.label)).toEqual([
      '换班模式',
      '设施选择',
      '无人机用途',
      '心情阈值',
      '自动补货',
      '自定义排班',
    ])
  })
})

describe('automation fight task catalog', () => {
  it('moves every fight helper into a tooltip without touching the copy', () => {
    for (const key of ['stages', 'drops', 'medicine', 'medicineExpireDays', 'stone', 'series']) {
      expect(fightParamField(key).helperPlacement).toBe('tooltip')
    }
    expect(fightParamField('stages').helper)
      .toBe('使用 HD-数字代表当前活动关卡；置顶关卡会优先执行。次数为该关卡的累计作战局数上限（连战中的每一局都计 1），留空表示不限制局数')
    expect(fightParamField('drops').helper)
      .toBe('任一物品达到目标数量后停止；格式为物品 ID=数量，多个目标用逗号分隔')
    expect(fightParamField('medicine').helper).toBe('使用理智药数量')
    expect(fightParamField('medicineExpireDays').helper)
      .toBe('使用将在指定天数内过期的理智药；0 表示不使用临期药')
    expect(fightParamField('stone').helper).toBe('使用源石数量')
    expect(fightParamField('series').helper)
      .toBe('本任务所有关卡共用的连战倍率，范围 -1 至 10（旧资源只支持 -1 至 6）；与各关卡次数同时生效：固定倍率时次数少于倍率不会开始任何一局（0 局）；指定倍率不能整除剩余次数时最后一轮连战不会开始，实际局数会少于次数；选“自动”会按剩余次数调整')
  })

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

describe('automation mall task catalog', () => {
  const mall = AVAILABLE_TASKS.find(task => task.id === 'mall')

  it('moves the three shopping helper texts into tooltips without touching the copy', () => {
    if (!mall) throw new Error('missing mall task')
    const fieldOf = (key: string) => mall.paramFields.find(field => field.key === key)

    expect(fieldOf('only_buy_discount')?.helper).toBe('仅影响优先购买之外的普通购物')
    expect(fieldOf('reserve_max_credit')?.helper).toBe('普通购物时信用低于 300 就停止购买')
    expect(fieldOf('credit_fight')?.helper).toBe('借助战完成一次 OF-1，以便次日获得更多信用')

    expect(fieldOf('only_buy_discount')?.helperPlacement).toBe('tooltip')
    expect(fieldOf('reserve_max_credit')?.helperPlacement).toBe('tooltip')
    expect(fieldOf('credit_fight')?.helperPlacement).toBe('tooltip')

    // 信用溢出开关本来就没有说明文案，不新增第四段提示。
    expect(fieldOf('force_shopping_if_credit_full')?.helper).toBeUndefined()
    expect(fieldOf('force_shopping_if_credit_full')?.helperPlacement).toBeUndefined()

    const inlineHelpers = mall.paramFields
      .filter(field => field.helper && field.helperPlacement !== 'tooltip')
      .map(field => field.key)
    expect(inlineHelpers).toEqual([])
  })

  it('keeps the mall switch order, labels, defaults and text placeholders untouched', () => {
    if (!mall) throw new Error('missing mall task')
    const fieldOf = (key: string) => mall.paramFields.find(field => field.key === key)

    expect(mall.taskType).toBe('Mall')
    expect(mall.paramFields.map(field => field.key)).toEqual([
      'visit_friends',
      'shopping',
      'buy_first',
      'blacklist',
      'only_buy_discount',
      'reserve_max_credit',
      'force_shopping_if_credit_full',
      'credit_fight',
      'formation_index',
    ])
    expect(mall.paramFields.map(field => field.label)).toEqual([
      '访问好友',
      '自动购物',
      '优先购买',
      '黑名单',
      '只买折扣商品',
      '保留 300 信用',
      '信用溢出时无视黑名单',
      '信用助战',
      '助战编队',
    ])
    expect(mall.defaultParams).toEqual({
      visit_friends: true,
      shopping: true,
      buy_first: '',
      blacklist: '',
      force_shopping_if_credit_full: false,
      only_buy_discount: false,
      reserve_max_credit: false,
      credit_fight: false,
      formation_index: 0,
    })
    expect(fieldOf('buy_first')?.placeholder).toBe('招聘许可,龙门币（逗号分隔）')
    expect(fieldOf('blacklist')?.placeholder).toBe('家具零件,碳（逗号分隔）')
    expect(fieldOf('only_buy_discount')?.visibleWhen).toEqual({ key: 'shopping', value: true })
    expect(fieldOf('reserve_max_credit')?.visibleWhen).toEqual({ key: 'shopping', value: true })
    expect(fieldOf('force_shopping_if_credit_full')?.visibleWhen).toEqual({ key: 'shopping', value: true })
    expect(fieldOf('credit_fight')?.visibleWhen).toBeUndefined()
    expect(fieldOf('formation_index')?.visibleWhen).toEqual({ key: 'credit_fight', value: true })
  })
})
