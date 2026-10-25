// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { GAME_DATA_DOMAIN, gameDataKeys } from './queryKeys'

describe('game data query keys', () => {
  it('uses the game-data domain as the invalidation scope', () => {
    expect(GAME_DATA_DOMAIN).toBe('game-data')
    expect(gameDataKeys.all).toEqual(['game-data'])
  })

  it('keeps one stable key per shared resource', () => {
    expect(gameDataKeys.resource('depot')).toEqual(['game-data', 'depot'])
    expect(gameDataKeys.resource('operbox')).toEqual(['game-data', 'operbox'])
    expect(gameDataKeys.resource('catalog')).toEqual(['game-data', 'catalog'])
    expect(gameDataKeys.query('catalog')).toEqual(['game-data', 'catalog'])
  })

  it('keeps the resource scope wider than a concrete identity', () => {
    expect(gameDataKeys.query('depot')).toEqual(gameDataKeys.resource('depot'))
  })
})
