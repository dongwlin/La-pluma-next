import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RECLAMATION_MODE,
  DEFAULT_ROGUELIKE_MODE,
  ROGUELIKE_TASKS,
  ROGUELIKE_THEME_PRESETS,
  buildRoguelikeCommandParams,
  getRoguelikeAdvancedOptions,
  normalizeRoguelikeAdvancedParams,
  resolveRoguelikeAdvancedValue,
  validateRoguelikeTaskInput,
} from './roguelikeTasks'

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
    expect(getRoguelikeAdvancedOptions('roguelike').map(option => [option.key, option.param]))
      .toEqual([
        ['mode', '--mode'],
        ['squad', '--squad'],
        ['coreChar', '--core-char'],
        ['startCount', '--start-count'],
        ['useSupport', '--use-support'],
        ['stopAtBoss', '--stop-at-final-boss'],
      ])
    expect(getRoguelikeAdvancedOptions('reclamation').map(option => [option.key, option.param]))
      .toEqual([
        ['mode', '-m'],
        ['toolsToCraft', '-C'],
        ['numBatches', '--num-craft-batches'],
      ])
    expect(getRoguelikeAdvancedOptions('unknown')).toEqual([])
  })

  it('names the roguelike mode options after their MaaCore behavior', () => {
    const roguelikeMode = getRoguelikeAdvancedOptions('roguelike')
      .find(option => option.key === 'mode')

    expect(roguelikeMode?.options).toEqual([
      { value: '0', label: '刷分模式' },
      { value: '1', label: '刷源石锭' },
      { value: '4', label: '刷开局' },
    ])
  })

  it('declares the reclamation mode default and its startup hint', () => {
    const reclamationMode = getRoguelikeAdvancedOptions('reclamation')
      .find(option => option.key === 'mode')
    expect(reclamationMode?.defaultValue).toBe(DEFAULT_RECLAMATION_MODE)
    expect(DEFAULT_RECLAMATION_MODE).toBe('1')
    expect(reclamationMode?.hint).toContain('存档')
    expect(reclamationMode?.hint).toContain('开始演算')
    expect(reclamationMode?.hint).toContain('驻扎地')

    // 集成战略的 CLI 默认与界面首项一致，保持省略而不声明默认值。
    expect(getRoguelikeAdvancedOptions('roguelike')
      .find(option => option.key === 'mode')?.defaultValue).toBeUndefined()
  })
})

describe('buildRoguelikeCommandParams', () => {
  it('appends configured values in option order', () => {
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
    )).toBe('Phantom --mode 1 --squad 指挥分队 --start-count 3 --use-support')
  })

  it('omits empty values and unchecked checkboxes', () => {
    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Sami' },
      { roguelike: { mode: '', useSupport: false } },
    )).toBe('Sami')
  })

  it('still passes model 4 as --mode 4 under its new name', () => {
    expect(buildRoguelikeCommandParams(
      'roguelike',
      { roguelike: 'Phantom' },
      { roguelike: { mode: '4' } },
    )).toBe('Phantom --mode 4')
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
  const reclamationMode = getRoguelikeAdvancedOptions('reclamation')
    .find(option => option.key === 'mode')!
  const roguelikeMode = getRoguelikeAdvancedOptions('roguelike')
    .find(option => option.key === 'mode')!
  const squad = getRoguelikeAdvancedOptions('roguelike')
    .find(option => option.key === 'squad')!

  it('resolves a missing or empty value to the declared default', () => {
    expect(resolveRoguelikeAdvancedValue(reclamationMode, {})).toBe(DEFAULT_RECLAMATION_MODE)
    expect(resolveRoguelikeAdvancedValue(reclamationMode, { mode: '' }))
      .toBe(DEFAULT_RECLAMATION_MODE)
  })

  it('keeps an explicit value over the declared default', () => {
    expect(resolveRoguelikeAdvancedValue(reclamationMode, { mode: '0' })).toBe('0')
  })

  it('keeps the first select option for fields without a declared default', () => {
    expect(resolveRoguelikeAdvancedValue(roguelikeMode, {})).toBe('0')
  })

  it('reports no value for empty plain fields', () => {
    expect(resolveRoguelikeAdvancedValue(squad, {})).toBeUndefined()
  })
})

describe('normalizeRoguelikeAdvancedParams', () => {
  it('fills declared defaults without overriding explicit values', () => {
    expect(normalizeRoguelikeAdvancedParams({})).toEqual({ reclamation: { mode: '1' } })
    expect(normalizeRoguelikeAdvancedParams({ reclamation: { mode: '' } }))
      .toEqual({ reclamation: { mode: '1' } })
    expect(normalizeRoguelikeAdvancedParams({ reclamation: { mode: '0' } }))
      .toEqual({ reclamation: { mode: '0' } })
    expect(normalizeRoguelikeAdvancedParams({ roguelike: { mode: '1' } }))
      .toEqual({ roguelike: { mode: '1' }, reclamation: { mode: '1' } })
  })

  it('returns the same reference when the draft is already normalized', () => {
    const advancedParams = { reclamation: { mode: '1' } }
    expect(normalizeRoguelikeAdvancedParams(advancedParams)).toBe(advancedParams)
  })

  it('does not mutate the inputs it receives', () => {
    const advancedParams = { roguelike: { mode: '1' } }

    normalizeRoguelikeAdvancedParams(advancedParams)

    expect(advancedParams).toEqual({ roguelike: { mode: '1' } })
  })
})

describe('validateRoguelikeTaskInput', () => {
  it('requires a non-empty theme for both modes', () => {
    expect(validateRoguelikeTaskInput('roguelike', {})).toBe('请输入主题名称')
    expect(validateRoguelikeTaskInput('roguelike', { roguelike: '   ' })).toBe('请输入主题名称')
    expect(validateRoguelikeTaskInput('reclamation', { reclamation: '' })).toBe('请输入主题名称')
  })

  it('accepts a configured theme and leaves unknown tasks to the caller', () => {
    expect(validateRoguelikeTaskInput('roguelike', { roguelike: 'Phantom' })).toBeNull()
    expect(validateRoguelikeTaskInput('reclamation', { reclamation: 'Tales' })).toBeNull()
    expect(validateRoguelikeTaskInput('unknown', {})).toBeNull()
  })
})
