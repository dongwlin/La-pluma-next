// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { defineQueryKeys } from './queryKeys'

const statisticsKeys = defineQueryKeys('statistics')
const combatKeys = defineQueryKeys('combat')

describe('defineQueryKeys', () => {
  it('builds the documented domain / resource / params hierarchy', () => {
    expect(statisticsKeys.all).toEqual(['statistics'])
    expect(statisticsKeys.resource('depot')).toEqual(['statistics', 'depot'])
    expect(statisticsKeys.query('drops', 7)).toEqual(['statistics', 'drops', 7])
    expect(combatKeys.query('copilot-search', { stage: '1-7', mode: null }))
      .toEqual(['combat', 'copilot-search', { stage: '1-7', mode: null }])
  })

  it('produces structurally identical keys for the same domain and resource', () => {
    expect(defineQueryKeys('statistics').query('drops', 7))
      .toEqual(statisticsKeys.query('drops', 7))
  })
})
