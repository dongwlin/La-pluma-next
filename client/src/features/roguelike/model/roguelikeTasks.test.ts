import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RECLAMATION_MODE,
  DEFAULT_ROGUELIKE_MODE,
  ROGUELIKE_TASKS,
  ROGUELIKE_THEME_PRESETS,
  buildRoguelikeCommandParams,
  getRoguelikeAdvancedOptions,
  getRoguelikeOptionChoices,
  isRoguelikeOptionVisible,
  normalizeRoguelikeAdvancedParams,
  normalizeRoguelikeModeForTheme,
  resolveRoguelikeAdvancedValue,
  splitRoguelikeListValue,
  validateRoguelikeTaskInput,
} from './roguelikeTasks'

const option = (key: string, taskId = 'roguelike') =>
  getRoguelikeAdvancedOptions(taskId).find(candidate => candidate.key === key)!

describe('roguelike task catalog', () => {
  it('keeps both modes and their execution commands', () => {
    expect(DEFAULT_ROGUELIKE_MODE).toBe('roguelike')
    expect(ROGUELIKE_TASKS.map(task => ({
      id: task.id,
      name: task.name,
      command: task.command,
    }))).toEqual([
      { id: 'roguelike', name: '集成战略', command: 'roguelike' },
      { id: 'reclamation', name: '生息演算', command: 'reclamation' },
    ])
  })

  it('provides the theme presets shown for each mode', () => {
    expect(ROGUELIKE_THEME_PRESETS.roguelike.map(theme => theme.value))
      .toEqual(['Phantom', 'Mizuki', 'Sami', 'Sarkaz', 'JieGarden'])
    expect(ROGUELIKE_THEME_PRESETS.reclamation).toEqual([
      { value: 'Tales', label: '沙洲遗闻' },
    ])
  })

  it('keeps the advanced option tables and their CLI parameters', () => {
    expect(getRoguelikeAdvancedOptions('roguelike').map(entry => [entry.key, entry.param]))
      .toEqual([
        ['mode', '--mode'],
        ['difficulty', '--difficulty'],
        ['squad', '--squad'],
        ['roles', '--roles'],
        ['coreChar', '--core-char'],
        ['startCount', '--start-count'],
        ['investmentsCount', '--investments-count'],
        ['startFoldartals', '--start-foldartals'],
        ['expectedCollapsalParadigms', '--expected-collapsal-paradigms'],
        ['useSupport', '--use-support'],
        ['useNonfriendSupport', '--use-nonfriend-support'],
        ['disableInvestment', '--disable-investment'],
        ['investmentWithMoreScore', '--investment-with-more-score'],
        ['noStopWhenInvestmentFull', '--no-stop-when-investment-full'],
        ['startWithEliteTwo', '--start-with-elite-two'],
        ['onlyStartWithEliteTwo', '--only-start-with-elite-two'],
        ['stopAtBoss', '--stop-at-final-boss'],
        ['refreshTraderWithDice', '--refresh-trader-with-dice'],
        ['useFoldartal', '--use-foldartal'],
        ['startWithSeed', '--start-with-seed'],
      ])
    expect(getRoguelikeAdvancedOptions('reclamation').map(entry => [entry.key, entry.param]))
      .toEqual([
        ['mode', '-m'],
        ['toolsToCraft', '-C'],
        ['numBatches', '--num-craft-batches'],
      ])
    expect(getRoguelikeAdvancedOptions('unknown')).toEqual([])
  })

  it('names the roguelike mode options after their MaaCore behavior', () => {
    const mode = option('mode')
    expect(getRoguelikeOptionChoices(mode, 'Phantom')).toEqual([
      { value: '0', label: '刷分模式' },
      { value: '1', label: '刷源石锭' },
      { value: '4', label: '刷开局' },
    ])
    const samiModes = getRoguelikeOptionChoices(mode, 'Sami') ?? []
    expect(samiModes[samiModes.length - 1]).toEqual({ value: '5', label: '刷坍缩范式' })
    expect(getRoguelikeOptionChoices(mode, 'Sarkaz')).toHaveLength(3)
  })

  it('declares the reclamation mode default and its startup hint', () => {
    const reclamationMode = option('mode', 'reclamation')
    expect(reclamationMode.defaultValue).toBe(DEFAULT_RECLAMATION_MODE)
    expect(DEFAULT_RECLAMATION_MODE).toBe('1')
    expect(reclamationMode.hint).toContain('存档')
    expect(reclamationMode.hint).toContain('开始演算')
    expect(reclamationMode.hint).toContain('驻扎地')

    // 集成战略的 CLI 默认与界面首项一致，保持省略而不声明默认值。
    expect(option('mode').defaultValue).toBeUndefined()
  })

  it('defaults the starting roles to a combination that covers the common core operators', () => {
    const roles = option('roles')
    expect(roles.defaultValue).toBe('稳扎稳打')
    const choices = getRoguelikeOptionChoices(roles, 'Sarkaz') ?? []
    expect(choices[0]).toEqual({ value: '稳扎稳打', label: '稳扎稳打（重装、术师、狙击）' })
    expect(choices.map(choice => choice.value))
      .toEqual(['稳扎稳打', '先手必胜', '取长补短', '随心所欲'])
    expect(getRoguelikeOptionChoices(roles, 'JieGarden')?.map(choice => choice.value))
      .toEqual(['稳扎稳打', '先手必胜', '取长补短', '灵活部署', '坚不可摧', '随心所欲'])
  })

  it('offers theme squads plus the shared pool without duplicates', () => {
    const squads = getRoguelikeOptionChoices(option('squad'), 'Sarkaz') ?? []
    expect(squads[0]).toEqual({ value: '', label: '默认（指挥分队）' })
    const values = squads.map(choice => choice.value)
    expect(values).toContain('蓝图测绘分队')
    expect(values).toContain('指挥分队')
    expect(values).toContain('高规格分队')
    expect(new Set(values).size).toBe(values.length)

    expect(getRoguelikeOptionChoices(option('squad'), 'JieGarden')?.map(choice => choice.value))
      .toContain('特勤分队')
  })

  it('matches theme choices after trimming the theme input', () => {
    const mode = option('mode')
    expect(getRoguelikeOptionChoices(mode, ' Sami ')).toHaveLength(4)
    expect(getRoguelikeOptionChoices(option('squad'), 'Sarkaz ')).toContainEqual({
      value: '蓝图测绘分队',
      label: '蓝图测绘分队',
    })
  })

  it('lists numeric difficulty only for themes that have one', () => {
    const difficulty = option('difficulty')
    expect(difficulty.themes).not.toContain('Phantom')
    const choices = getRoguelikeOptionChoices(difficulty, 'Sami') ?? []
    expect(choices[0]).toEqual({ value: '-1', label: '不切换（沿用游戏内难度）' })
    expect(choices.map(choice => choice.value)).toContain('15')
    expect(choices[choices.length - 1]).toEqual({ value: '0', label: '0（最低）' })
  })
})

describe('isRoguelikeOptionVisible', () => {
  it('ties theme-specific switches to the active theme', () => {
    expect(isRoguelikeOptionVisible(option('useFoldartal'), 'roguelike', 'Sami', {})).toBe(true)
    expect(isRoguelikeOptionVisible(option('useFoldartal'), 'roguelike', 'Sarkaz', {})).toBe(false)
    expect(isRoguelikeOptionVisible(option('refreshTraderWithDice'), 'roguelike', 'Mizuki', {})).toBe(true)
    expect(isRoguelikeOptionVisible(option('startWithSeed'), 'roguelike', 'Sarkaz', { mode: '1' })).toBe(true)
    expect(isRoguelikeOptionVisible(option('startWithSeed'), 'roguelike', 'Sarkaz', { mode: '0' })).toBe(false)
    expect(isRoguelikeOptionVisible(option('difficulty'), 'roguelike', 'Phantom', {})).toBe(false)
  })

  it('ties mode-specific fields to the resolved mode', () => {
    expect(isRoguelikeOptionVisible(option('expectedCollapsalParadigms'), 'roguelike', 'Sami', { mode: '5' }))
      .toBe(true)
    expect(isRoguelikeOptionVisible(option('expectedCollapsalParadigms'), 'roguelike', 'Sami', { mode: '0' }))
      .toBe(false)
    expect(isRoguelikeOptionVisible(option('startWithEliteTwo'), 'roguelike', 'Sarkaz', { mode: '4' })).toBe(true)
    expect(isRoguelikeOptionVisible(option('startWithEliteTwo'), 'roguelike', 'Sarkaz', { mode: '0' })).toBe(false)
    expect(isRoguelikeOptionVisible(option('stopAtBoss'), 'roguelike', 'Sarkaz', {})).toBe(true)
    expect(isRoguelikeOptionVisible(option('stopAtBoss'), 'roguelike', 'Sarkaz', { mode: '1' })).toBe(false)
  })

  it('follows the field a switch depends on, including the default-off case', () => {
    const investmentsCount = option('investmentsCount')
    expect(isRoguelikeOptionVisible(investmentsCount, 'roguelike', 'Sarkaz', {})).toBe(true)
    expect(isRoguelikeOptionVisible(investmentsCount, 'roguelike', 'Sarkaz', { disableInvestment: true }))
      .toBe(false)

    const onlyEliteTwo = option('onlyStartWithEliteTwo')
    expect(isRoguelikeOptionVisible(onlyEliteTwo, 'roguelike', 'Sarkaz', { mode: '4' })).toBe(false)
    expect(isRoguelikeOptionVisible(onlyEliteTwo, 'roguelike', 'Sarkaz', {
      mode: '4',
      startWithEliteTwo: true,
    })).toBe(true)

    const nonfriendSupport = option('useNonfriendSupport')
    expect(isRoguelikeOptionVisible(nonfriendSupport, 'roguelike', 'Sarkaz', {})).toBe(false)
    expect(isRoguelikeOptionVisible(nonfriendSupport, 'roguelike', 'Sarkaz', { useSupport: true })).toBe(true)
  })
})

describe('buildRoguelikeCommandParams', () => {
  it('appends configured values in option order and always writes the role default', () => {
    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Phantom' },
      {
        roguelike: {
          mode: '1',
          squad: '指挥分队',
          coreChar: '',
          startCount: 3,
          useSupport: true,
          stopAtBoss: false,
        },
      },
    )).toBe('Phantom --mode 1 --squad 指挥分队 --roles 稳扎稳打 --start-count 3 --use-support')
  })

  it('omits empty values, unchecked checkboxes and fields the theme does not support', () => {
    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Sarkaz' },
      {
        roguelike: {
          mode: '',
          useSupport: false,
          useFoldartal: true,
          refreshTraderWithDice: true,
        },
      },
    )).toBe('Sarkaz --roles 稳扎稳打')
  })

  it('keeps fields the active theme supports', () => {
    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Sami' },
      { roguelike: { useFoldartal: true, difficulty: '6' } },
    )).toBe('Sami --difficulty 6 --roles 稳扎稳打 --use-foldartal')
  })

  it('writes list fields once per value', () => {
    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Sami' },
      { roguelike: { mode: '5', expectedCollapsalParadigms: '目空一些，图像损坏' } },
    )).toBe('Sami --mode 5 --roles 稳扎稳打 --expected-collapsal-paradigms 目空一些 --expected-collapsal-paradigms 图像损坏')
  })

  it('keeps mode-specific switches out of other modes', () => {
    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Sarkaz' },
      { roguelike: { mode: '4', startWithEliteTwo: true, onlyStartWithEliteTwo: true, stopAtBoss: true } },
    )).toBe('Sarkaz --mode 4 --roles 稳扎稳打 --start-with-elite-two --only-start-with-elite-two')

    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Sarkaz' },
      { roguelike: { stopAtBoss: true } },
    )).toBe('Sarkaz --roles 稳扎稳打 --stop-at-final-boss')
  })

  it('still passes mode 4 as --mode 4 under its new name', () => {
    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Phantom' },
      { roguelike: { mode: '4', squad: '突击战术分队' } },
    )).toBe('Phantom --mode 4 --squad 突击战术分队 --roles 稳扎稳打')
  })

  it('builds reclamation commands with its own parameters', () => {
    expect(buildRoguelikeCommandParams(
      'reclamation',
      { reclamation: 'Tales' },
      { reclamation: { mode: '0', toolsToCraft: '荧光棒', numBatches: 2 } },
    )).toBe('Tales -m 0 -C 荧光棒 --num-craft-batches 2')
  })

  it('always writes the reclamation mode, falling back to the declared default', () => {
    const build = (advancedParams: Parameters<typeof buildRoguelikeCommandParams>[2]) =>
      buildRoguelikeCommandParams('reclamation', { reclamation: 'Tales' }, advancedParams)

    expect(build({})).toBe('Tales -m 1')
    expect(build({ reclamation: { toolsToCraft: '' } })).toBe('Tales -m 1')
    expect(build({ reclamation: { mode: '' } })).toBe('Tales -m 1')
    expect(build({ reclamation: { mode: '0' } })).toBe('Tales -m 0')
    expect(build({ reclamation: { mode: '1' } })).toBe('Tales -m 1')
    expect(build({ reclamation: { mode: 0 } })).toBe('Tales -m 0')
  })

  it('does not mutate the inputs it receives', () => {
    const taskInputs = { roguelike: 'Phantom' }
    const advancedParams = { roguelike: { mode: '1' } }

    buildRoguelikeCommandParams('roguelike', taskInputs, advancedParams)

    expect(taskInputs).toEqual({ roguelike: 'Phantom' })
    expect(advancedParams).toEqual({ roguelike: { mode: '1' } })
  })
})

describe('resolveRoguelikeAdvancedValue', () => {
  it('resolves a missing or empty value to the declared default', () => {
    expect(resolveRoguelikeAdvancedValue(option('mode', 'reclamation'), {}))
      .toBe(DEFAULT_RECLAMATION_MODE)
    expect(resolveRoguelikeAdvancedValue(option('mode', 'reclamation'), { mode: '' }))
      .toBe(DEFAULT_RECLAMATION_MODE)
    expect(resolveRoguelikeAdvancedValue(option('roles'), {})).toBe('稳扎稳打')
  })

  it('keeps an explicit value over the declared default', () => {
    expect(resolveRoguelikeAdvancedValue(option('mode', 'reclamation'), { mode: '0' })).toBe('0')
    expect(resolveRoguelikeAdvancedValue(option('roles'), { roles: '先手必胜' })).toBe('先手必胜')
  })

  it('keeps the first choice of the active theme for selects without a declared default', () => {
    expect(resolveRoguelikeAdvancedValue(option('mode'), {}, 'Sarkaz')).toBe('0')
    expect(resolveRoguelikeAdvancedValue(option('difficulty'), {}, 'Sarkaz')).toBe('-1')
    expect(resolveRoguelikeAdvancedValue(option('squad'), {})).toBe('')
  })
})

describe('splitRoguelikeListValue', () => {
  it('splits on common separators and drops empty items', () => {
    expect(splitRoguelikeListValue('英雄,大地、目空一些；图像损坏  '))
      .toEqual(['英雄', '大地', '目空一些', '图像损坏'])
    expect(splitRoguelikeListValue('')).toEqual([])
    expect(splitRoguelikeListValue(undefined)).toEqual([])
  })
})

describe('normalizeRoguelikeAdvancedParams', () => {
  it('fills declared defaults without overriding explicit values', () => {
    expect(normalizeRoguelikeAdvancedParams({}))
      .toEqual({ roguelike: { roles: '稳扎稳打' }, reclamation: { mode: '1' } })
    expect(normalizeRoguelikeAdvancedParams({ reclamation: { mode: '' } }))
      .toEqual({ roguelike: { roles: '稳扎稳打' }, reclamation: { mode: '1' } })
    expect(normalizeRoguelikeAdvancedParams({ reclamation: { mode: '0' } }))
      .toEqual({ roguelike: { roles: '稳扎稳打' }, reclamation: { mode: '0' } })
    expect(normalizeRoguelikeAdvancedParams({ roguelike: { roles: '取长补短' } }))
      .toEqual({ roguelike: { roles: '取长补短' }, reclamation: { mode: '1' } })
    expect(normalizeRoguelikeAdvancedParams({ roguelike: { mode: '1' } }))
      .toEqual({ roguelike: { mode: '1', roles: '稳扎稳打' }, reclamation: { mode: '1' } })
  })

  it('returns the same reference when the draft is already normalized', () => {
    const advancedParams = { roguelike: { roles: '稳扎稳打' }, reclamation: { mode: '1' } }
    expect(normalizeRoguelikeAdvancedParams(advancedParams)).toBe(advancedParams)
  })

  it('does not mutate the inputs it receives', () => {
    const advancedParams = { roguelike: { mode: '1' } }

    normalizeRoguelikeAdvancedParams(advancedParams)

    expect(advancedParams).toEqual({ roguelike: { mode: '1' } })
  })
})

describe('normalizeRoguelikeModeForTheme', () => {
  it('drops a mode the new theme does not support and keeps the rest', () => {
    expect(normalizeRoguelikeModeForTheme('roguelike', 'Sarkaz', {
      roguelike: { mode: '5', expectedCollapsalParadigms: '目空一些', squad: '蓝图测绘分队' },
    })).toEqual({
      roguelike: { mode: '0', expectedCollapsalParadigms: '目空一些', squad: '蓝图测绘分队' },
    })
  })

  it('keeps a supported mode and untouched drafts', () => {
    const supported = { roguelike: { mode: '5' } }
    expect(normalizeRoguelikeModeForTheme('roguelike', 'Sami', supported)).toBe(supported)

    const untouched = { reclamation: { mode: '1' } }
    expect(normalizeRoguelikeModeForTheme('reclamation', 'Tales', untouched)).toBe(untouched)
  })
})

describe('validateRoguelikeTaskInput', () => {
  it('requires a non-empty theme for both modes', () => {
    expect(validateRoguelikeTaskInput('roguelike', {})).toBe('请输入主题名称')
    expect(validateRoguelikeTaskInput('roguelike', { roguelike: '   ' })).toBe('请输入主题名称')
    expect(validateRoguelikeTaskInput('reclamation', { reclamation: '' })).toBe('请输入主题名称')
  })

  it('requires the expected collapsal paradigms in mode 5', () => {
    const inputs = { roguelike: 'Sami' }
    expect(validateRoguelikeTaskInput('roguelike', inputs, { roguelike: { mode: '5' } }))
      .toBe('刷坍缩范式模式需要填写期望坍缩范式')
    expect(validateRoguelikeTaskInput('roguelike', inputs, {
      roguelike: { mode: '5', expectedCollapsalParadigms: '目空一些' },
    })).toBeNull()
    expect(validateRoguelikeTaskInput('roguelike', inputs, { roguelike: { mode: '0' } })).toBeNull()
  })

  it('accepts a configured theme and leaves unknown tasks to the caller', () => {
    expect(validateRoguelikeTaskInput('roguelike', { roguelike: 'Phantom' })).toBeNull()
    expect(validateRoguelikeTaskInput('reclamation', { reclamation: 'Tales' })).toBeNull()
    expect(validateRoguelikeTaskInput('unknown', {})).toBeNull()
  })
})
