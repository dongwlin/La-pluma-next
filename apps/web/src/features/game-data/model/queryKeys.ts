import { defineQueryKeys } from '@/shared/query'

export const GAME_DATA_DOMAIN = 'game-data' as const

export const gameDataKeys = defineQueryKeys(GAME_DATA_DOMAIN)

export type GameDataResource = 'depot' | 'operbox' | 'catalog'
