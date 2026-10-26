import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ROGUELIKE_MODE,
  ROGUELIKE_TASKS,
  ROGUELIKE_THEME_PRESETS,
  buildRoguelikeCommandParams,
  getRoguelikeAdvancedOptions,
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

  it('builds reclamation commands with its own parameters', () => {
    expect(buildRoguelikeCommandParams(
      'reclamation',
      { reclamation: 'Tales' },
      { reclamation: { mode: '0', toolsToCraft: '荧光棒', numBatches: 2 } },
    )).toBe('Tales -m 0 -C 荧光棒 --num-craft-batches 2')
  })

  it('does not mutate the inputs it receives', () => {
    const taskInputs = { roguelike: 'Phantom' }
    const advancedParams = { roguelike: { mode: '1' } }

    buildRoguelikeCommandParams('roguelike', taskInputs, advancedParams)

    expect(taskInputs).toEqual({ roguelike: 'Phantom' })
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
