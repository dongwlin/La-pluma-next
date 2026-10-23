import { describe, expect, it } from 'vitest'
import { normalizeCopilotInput, normalizeCopilotUri, parseCopilotUri, splitCopilotInputToArgs } from './copilotUri'

describe('copilot URI migration', () => {
  it.each([
    ['maa://1234', 'prts://1234', false],
    ['maa://1234s', 'prts://s1234', true],
    ['prts://1234', 'prts://1234', false],
    ['PRTS://S1234', 'prts://s1234', true],
    ['https://prts.plus/?op=1234', 'prts://1234', false],
    ['https://zoot.plus/copilot/1234', 'prts://1234', false],
    ['https://zoot.plus/set/1234', 'prts://s1234', true],
  ])('normalizes %s', (input, expected, isSet) => {
    expect(normalizeCopilotUri(input)).toBe(expected)
    expect(parseCopilotUri(expected)).toEqual({ id: '1234', isSet })
  })

  it('keeps local file arguments with spaces and converts multiple URIs', () => {
    expect(splitCopilotInputToArgs('maa://12 maa://34s\nprts://s56 "/tmp/local copilot.json"')).toEqual([
      'prts://12', 'prts://s34', 'prts://s56', '/tmp/local copilot.json',
    ])
    expect(normalizeCopilotInput(' maa://12\n\nmaa://34s ')).toBe('prts://12 prts://s34')
  })

  it.each(['prts://1234s', 'prts://s', 'maa://s1234', '/tmp/copilot.json', 'file:///tmp/copilot.json'])(
    'does not rewrite non-URI input %s', input => {
      expect(parseCopilotUri(input)).toBeNull()
      expect(normalizeCopilotUri(input)).toBe(input)
    },
  )
})
