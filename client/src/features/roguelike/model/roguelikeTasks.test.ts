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
      { value: '6', label: '刷月度小队' },
      { value: '7', label: '刷深入调查' },
    ])
    expect((getRoguelikeOptionChoices(mode, 'Sami') ?? []).map(choice => choice.value))
      .toEqual(['0', '1', '4', '5', '6', '7'])
    expect(getRoguelikeOptionChoices(mode, 'Sarkaz')).toHaveLength(5)
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
    expect(getRoguelikeOptionChoices(mode, ' Sami ')).toHaveLength(6)
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
    expect(isRoguelikeOptionVisible(option('startWithSeed'), 'roguelike', 'Sarkaz', {
      mode: '1',
      squad: '点刺成锭分队',
    })).toBe(true)
    expect(isRoguelikeOptionVisible(option('startWithSeed'), 'roguelike', 'Sarkaz', {
      mode: '1',
      squad: '后勤分队',
    })).toBe(true)
    expect(isRoguelikeOptionVisible(option('startWithSeed'), 'roguelike', 'Sarkaz', {
      mode: '1',
      squad: '指挥分队',
    })).toBe(false)
    expect(isRoguelikeOptionVisible(option('startWithSeed'), 'roguelike', 'Sarkaz', {
      mode: '0',
      squad: '点刺成锭分队',
    })).toBe(false)
    expect(isRoguelikeOptionVisible(option('startWithSeed'), 'roguelike', 'Sami', {
      mode: '1',
      squad: '点刺成锭分队',
    })).toBe(false)
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

  it('ties the starting foldartals to the Sami collectible mode and squad', () => {
    const foldartals = option('startFoldartals')
    expect(isRoguelikeOptionVisible(foldartals, 'roguelike', 'Sami', {
      mode: '4',
      squad: '生活至上分队',
    })).toBe(true)
    expect(isRoguelikeOptionVisible(foldartals, 'roguelike', 'Sami', {
      mode: '4',
      squad: '指挥分队',
    })).toBe(false)
    expect(isRoguelikeOptionVisible(foldartals, 'roguelike', 'Sami', {
      mode: '0',
      squad: '生活至上分队',
    })).toBe(false)
    expect(isRoguelikeOptionVisible(foldartals, 'roguelike', 'Sarkaz', {
      mode: '4',
      squad: '生活至上分队',
    })).toBe(false)
  })

  it('ties reclamation tool crafting fields to mode 1', () => {
    for (const key of ['toolsToCraft', 'numBatches']) {
      expect(isRoguelikeOptionVisible(option(key, 'reclamation'), 'reclamation', 'Tales', { mode: '1' }))
        .toBe(true)
      expect(isRoguelikeOptionVisible(option(key, 'reclamation'), 'reclamation', 'Tales', { mode: '0' }))
        .toBe(false)
    }
  })

  it('ties the investment score option to the investment mode', () => {
    const moreScore = option('investmentWithMoreScore')
    expect(isRoguelikeOptionVisible(moreScore, 'roguelike', 'Sarkaz', { mode: '1' })).toBe(true)
    expect(isRoguelikeOptionVisible(moreScore, 'roguelike', 'Sarkaz', { mode: '0' })).toBe(false)
    expect(isRoguelikeOptionVisible(moreScore, 'roguelike', 'Sarkaz', { mode: '4' })).toBe(false)
    expect(isRoguelikeOptionVisible(moreScore, 'roguelike', 'Sarkaz', {
      mode: '1',
      disableInvestment: true,
    })).toBe(false)
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

  it('passes the specified seed as an option value', () => {
    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Sarkaz' },
      { roguelike: { mode: '1', squad: '点刺成锭分队', startWithSeed: '2b3c4d,rogue_1,120' } },
    )).toBe('Sarkaz --mode 1 --squad 点刺成锭分队 --roles 稳扎稳打 --start-with-seed 2b3c4d,rogue_1,120')
  })

  it('writes starting foldartals only for the Sami collectible squad', () => {
    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Sami' },
      { roguelike: { mode: '4', squad: '生活至上分队', startFoldartals: '英雄，大地' } },
    )).toBe('Sami --mode 4 --squad 生活至上分队 --roles 稳扎稳打 --start-foldartals 英雄 --start-foldartals 大地')

    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Sami' },
      { roguelike: { mode: '4', squad: '指挥分队', startFoldartals: '英雄' } },
    )).toBe('Sami --mode 4 --squad 指挥分队 --roles 稳扎稳打')

    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Sami' },
      { roguelike: { mode: '0', squad: '生活至上分队', startFoldartals: '英雄' } },
    )).toBe('Sami --mode 0 --squad 生活至上分队 --roles 稳扎稳打')
  })

  it('does not write select values outside the active theme choices', () => {
    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Sami' },
      { roguelike: { squad: '蓝图测绘分队', difficulty: '18' } },
    )).toBe('Sami --roles 稳扎稳打')

    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Sarkaz' },
      { roguelike: { roles: '灵活部署' } },
    )).toBe('Sarkaz')
  })

  it('writes integer options and drops malformed numbers', () => {
    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Sarkaz' },
      { roguelike: { startCount: ' 3 ', investmentsCount: 2 } },
    )).toBe('Sarkaz --roles 稳扎稳打 --start-count 3 --investments-count 2')

    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Sarkaz' },
      { roguelike: { startCount: '1.5', investmentsCount: '2' } },
    )).toBe('Sarkaz --roles 稳扎稳打 --investments-count 2')

    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Sarkaz' },
      { roguelike: { startCount: '-1' } },
    )).toBe('Sarkaz --roles 稳扎稳打')
  })

  it('writes list fields once per value', () => {
    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Sami' },
      { roguelike: { mode: '5', expectedCollapsalParadigms: '目空一些，图像损坏' } },
    )).toBe('Sami --mode 5 --roles 稳扎稳打 --expected-collapsal-paradigms 目空一些 --expected-collapsal-paradigms 图像损坏')
  })

  it('writes the investment score option only in the investment mode', () => {
    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Sarkaz' },
      { roguelike: { mode: '1', investmentWithMoreScore: true } },
    )).toBe('Sarkaz --mode 1 --roles 稳扎稳打 --investment-with-more-score')

    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Sarkaz' },
      { roguelike: { mode: '0', investmentWithMoreScore: true } },
    )).toBe('Sarkaz --mode 0 --roles 稳扎稳打')
  })

  it('passes the monthly squad and deep exploration modes to the CLI', () => {
    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Mizuki' },
      { roguelike: { mode: '6' } },
    )).toBe('Mizuki --mode 6 --roles 稳扎稳打')

    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Sarkaz' },
      { roguelike: { mode: '7' } },
    )).toBe('Sarkaz --mode 7 --roles 稳扎稳打')
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
      { reclamation: { mode: '1', toolsToCraft: '荧光棒', numBatches: 2 } },
    )).toBe('Tales -m 1 -C 荧光棒 --num-craft-batches 2')
  })

  it('omits the tool crafting fields in reclamation mode 0', () => {
    expect(buildRoguelikeCommandParams(
      'reclamation',
      { reclamation: 'Tales' },
      { reclamation: { mode: '0', toolsToCraft: '荧光棒', numBatches: 2 } },
    )).toBe('Tales -m 0')
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

  it('rejects select values outside the active theme choices', () => {
    expect(validateRoguelikeTaskInput(
      'roguelike',
      { roguelike: 'Sami' },
      { roguelike: { squad: '蓝图测绘分队' } },
    )).toBe('起始分队「蓝图测绘分队」不在当前主题的可选范围内，请重新选择')
    expect(validateRoguelikeTaskInput(
      'roguelike',
      { roguelike: 'Sarkaz' },
      { roguelike: { roles: '灵活部署' } },
    )).toBe('开局职业组「灵活部署」不在当前主题的可选范围内，请重新选择')
    expect(validateRoguelikeTaskInput(
      'roguelike',
      { roguelike: 'Sami' },
      { roguelike: { difficulty: '18' } },
    )).toBe('难度「18」不在当前主题的可选范围内，请重新选择')
  })

  it('ignores invalid values of fields hidden by the active theme', () => {
    expect(validateRoguelikeTaskInput(
      'roguelike',
      { roguelike: 'Phantom' },
      { roguelike: { difficulty: '18' } },
    )).toBeNull()
    expect(validateRoguelikeTaskInput(
      'roguelike',
      { roguelike: 'Sami' },
      { roguelike: { squad: '永恒狩猎分队' } },
    )).toBeNull()
  })

  it('rejects non-integer and out-of-range numbers', () => {
    const inputs = { roguelike: 'Sarkaz' }
    expect(validateRoguelikeTaskInput('roguelike', inputs, { roguelike: { startCount: '1.5' } }))
      .toBe('运行次数需为整数')
    expect(validateRoguelikeTaskInput('roguelike', inputs, { roguelike: { startCount: '1e3' } }))
      .toBe('运行次数需为整数')
    expect(validateRoguelikeTaskInput('roguelike', inputs, { roguelike: { startCount: '-1' } }))
      .toBe('运行次数需在 1–2147483647 之间')
    expect(validateRoguelikeTaskInput('roguelike', inputs, { roguelike: { startCount: '0' } }))
      .toBe('运行次数需在 1–2147483647 之间')
    expect(validateRoguelikeTaskInput('roguelike', inputs, { roguelike: { startCount: '2147483648' } }))
      .toBe('运行次数需在 1–2147483647 之间')
    expect(validateRoguelikeTaskInput('roguelike', inputs, { roguelike: { investmentsCount: '2.5' } }))
      .toBe('投资次数需为整数')

    expect(validateRoguelikeTaskInput('roguelike', inputs, { roguelike: { startCount: '3' } }))
      .toBeNull()
    expect(validateRoguelikeTaskInput('roguelike', inputs, { roguelike: { startCount: '' } }))
      .toBeNull()
    expect(validateRoguelikeTaskInput('roguelike', inputs, { roguelike: { startCount: '   ' } }))
      .toBeNull()
  })

  it('validates the reclamation batch count only in mode 1', () => {
    const inputs = { reclamation: 'Tales' }
    expect(validateRoguelikeTaskInput('reclamation', inputs, {
      reclamation: { mode: '1', numBatches: '0' },
    })).toBe('批次数需在 1–2147483647 之间')
    expect(validateRoguelikeTaskInput('reclamation', inputs, {
      reclamation: { mode: '1', numBatches: '2.5' },
    })).toBe('批次数需为整数')
    expect(validateRoguelikeTaskInput('reclamation', inputs, {
      reclamation: { mode: '0', numBatches: '0' },
    })).toBeNull()
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
