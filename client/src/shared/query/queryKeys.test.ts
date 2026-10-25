// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { createQueryClient } from './queryClient'
import { defineQueryKeys } from './queryKeys'

const statisticsKeys = defineQueryKeys('statistics')
const trainingKeys = defineQueryKeys('training')
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

  it('invalidates every resource in one domain without touching another domain', async () => {
    const client = createQueryClient()
    client.setQueryData(statisticsKeys.resource('depot'), { items: [] })
    client.setQueryData(statisticsKeys.query('drops', 7), [])
    client.setQueryData(trainingKeys.resource('queue'), [])

    await client.invalidateQueries({ queryKey: statisticsKeys.all })

    expect(client.getQueryState(statisticsKeys.resource('depot'))?.isInvalidated).toBe(true)
    expect(client.getQueryState(statisticsKeys.query('drops', 7))?.isInvalidated).toBe(true)
    expect(client.getQueryState(trainingKeys.resource('queue'))?.isInvalidated).toBe(false)
  })

  it('invalidates one resource across parameter variants only', async () => {
    const client = createQueryClient()
    client.setQueryData(statisticsKeys.query('drops', 7), [])
    client.setQueryData(statisticsKeys.query('drops', 30), [])
    client.setQueryData(statisticsKeys.resource('depot'), { items: [] })
    client.setQueryData(trainingKeys.resource('queue'), [])

    await client.invalidateQueries({ queryKey: statisticsKeys.resource('drops') })

    expect(client.getQueryState(statisticsKeys.query('drops', 7))?.isInvalidated).toBe(true)
    expect(client.getQueryState(statisticsKeys.query('drops', 30))?.isInvalidated).toBe(true)
    expect(client.getQueryState(statisticsKeys.resource('depot'))?.isInvalidated).toBe(false)
    expect(client.getQueryState(trainingKeys.resource('queue'))?.isInvalidated).toBe(false)
  })
})
