// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  appendCombatCommandOptions,
  buildCombatCommandArgs,
  buildCopilotSetExecutionOptions,
  getCombatAdvancedOptions,
  normalizeFormationMode,
  raidFromAdvanced,
  shouldAppendFormation,
  toCopilotSetRunMode,
  validateCombatInput,
} from './combatCommands'

describe('advanced option table', () => {
  it('keeps the documented copilot options and their empty-param strategy', () => {
    const options = getCombatAdvancedOptions('copilot')
    expect(options.map(option => option.key)).toEqual([
      'ignoreRequirements',
      'loopTimes',
      'executionStrategy',
      'formationIndex',
      'addTrust',
      'useSanityPotion',
      'supportUsage',
      'supportName',
    ])
    expect(options.find(option => option.key === 'executionStrategy')?.param).toBe('')
    expect(getCombatAdvancedOptions('unknown')).toEqual([])
  })
})

describe('formation and raid rules', () => {
  it('normalizes legacy booleans and unknown values', () => {
    expect(normalizeFormationMode(true)).toBe('on')
    expect(normalizeFormationMode(false)).toBe('off')
    expect(normalizeFormationMode('auto')).toBe('auto')
    expect(normalizeFormationMode(undefined)).toBe('auto')
    expect(normalizeFormationMode('bad')).toBe('auto')
  })

  it('only appends formation for copilot and honors auto split execution', () => {
    expect(shouldAppendFormation('copilot', 'on')).toBe(true)
    expect(shouldAppendFormation('copilot', 'off')).toBe(false)
    expect(shouldAppendFormation('copilot', 'auto')).toBe(false)
    expect(shouldAppendFormation('copilot', 'auto', true)).toBe(true)
    expect(shouldAppendFormation('ssscopilot', 'on')).toBe(false)
  })

  it('normalizes legacy raid values for commands and requests', () => {
    expect(raidFromAdvanced({ raid: '1' })).toBe('raid')
    expect(raidFromAdvanced({ raid: '2' })).toBe('both')
    expect(raidFromAdvanced(undefined)).toBe('normal')
  })
})

describe('buildCombatCommandArgs', () => {
  it('splits input and appends formation, raid and set advanced options', () => {
    expect(buildCombatCommandArgs('copilot', {
      input: 'prts://1234 prts://s5678',
      formationMode: 'on',
      advanced: {
        ignoreRequirements: true,
        loopTimes: 2,
        executionStrategy: 'stop',
        addTrust: false,
        supportName: '',
        raid: '1',
      },
    })).toEqual([
      'prts://1234',
      'prts://s5678',
      '--formation',
      '--raid',
      'raid',
      '--ignore-requirements',
      '--loop-times',
      '2',
    ])
  })

  it('rewrites bare set ids only when the preview says the input lacks the s prefix', () => {
    expect(buildCombatCommandArgs('copilot', {
      input: 'prts://1234',
      autoAddSetPrefix: true,
    })).toEqual(['prts://s1234'])
    expect(buildCombatCommandArgs('copilot', {
      input: 'prts://1234',
      autoAddSetPrefix: false,
    })).toEqual(['prts://1234'])
    expect(buildCombatCommandArgs('ssscopilot', {
      input: 'prts://1234',
      autoAddSetPrefix: true,
    })).toEqual(['prts://1234'])
  })

  it('keeps empty values and empty-param strategies out of the command line', () => {
    expect(buildCombatCommandArgs('paradoxcopilot', {
      input: 'prts://9',
      advanced: { executionStrategy: 'stop', loopTimes: '' },
      formationMode: 'on',
    })).toEqual(['prts://9'])
    expect(buildCombatCommandArgs('ssscopilot', {
      input: 'prts://9',
      advanced: { loopTimes: '1' },
      formationMode: 'on',
    })).toEqual(['prts://9', '--loop-times', '1'])
  })

  it('appends raid only for copilot and non-normal modes', () => {
    expect(buildCombatCommandArgs('copilot', {
      input: 'prts://1',
      advanced: { raid: '2' },
    })).toEqual(['prts://1', '--raid', 'both'])
    expect(buildCombatCommandArgs('copilot', { input: 'prts://1' }))
      .toEqual(['prts://1'])
    expect(buildCombatCommandArgs('ssscopilot', {
      input: 'prts://1',
      advanced: { raid: 'raid' },
    })).toEqual(['prts://1'])
  })

  it('does not duplicate options when appending to an existing arg list', () => {
    expect(appendCombatCommandOptions(['prts://1'], 'copilot', {
      advanced: { raid: 'raid', ignoreRequirements: true },
      formationMode: 'auto',
    })).toEqual(['prts://1', '--raid', 'raid', '--ignore-requirements'])
  })
})

describe('set execution model', () => {
  it('builds the documented options payload', () => {
    expect(buildCopilotSetExecutionOptions({
      ignoreRequirements: true,
      loopTimes: '2',
      useSanityPotion: false,
      addTrust: true,
      formationIndex: '1',
      supportUsage: '0',
      supportName: '临光',
      raid: 'raid',
    }, 'off')).toEqual({
      ignoreRequirements: true,
      loopTimes: '2',
      useSanityPotion: false,
      addTrust: true,
      formationIndex: '1',
      supportUsage: '0',
      supportName: '临光',
      formationMode: 'off',
    })

    expect(buildCopilotSetExecutionOptions(undefined, 'auto')).toEqual({
      ignoreRequirements: undefined,
      loopTimes: undefined,
      useSanityPotion: undefined,
      addTrust: undefined,
      formationIndex: undefined,
      supportUsage: undefined,
      supportName: undefined,
      formationMode: 'auto',
    })
  })

  it('maps app/cli to continuous and keeps manual', () => {
    expect(toCopilotSetRunMode('app')).toBe('continuous')
    expect(toCopilotSetRunMode('cli')).toBe('continuous')
    expect(toCopilotSetRunMode('manual')).toBe('manual')
  })
})

describe('validateCombatInput', () => {
  it('requires an input for the three copilot commands', () => {
    expect(validateCombatInput('copilot', '   ')).toBe('请输入作业链接')
    expect(validateCombatInput('paradoxcopilot', '')).toBe('请输入作业链接')
    expect(validateCombatInput('ssscopilot', '')).toBe('请输入作业链接')
    expect(validateCombatInput('other', '')).toBeNull()
  })

  it('allows one SSS URI only', () => {
    expect(validateCombatInput('ssscopilot', 'prts://1')).toBeNull()
    expect(validateCombatInput('ssscopilot', 'prts://1 prts://2'))
      .toBe('保全派驻一次只能执行一个 SSS 作业 URI')
    expect(validateCombatInput('copilot', 'prts://1 prts://2')).toBeNull()
  })
})
