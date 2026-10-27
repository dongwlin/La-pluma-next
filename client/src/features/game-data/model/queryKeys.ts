/**
 * 游戏数据资源共享 Query key
 *
 * 域标识 `game-data` 与 feature 目录一致；资源名与
 * `docs/architecture/query-cache.md` 的资源命名及 `resource-invalidation` 的失效作用域对齐。
 * 物品图标不是 Query 资源，没有对应 key。
 */

import { defineQueryKeys } from '@/shared/query'

export const GAME_DATA_DOMAIN = 'game-data' as const

export const gameDataKeys = defineQueryKeys(GAME_DATA_DOMAIN)

export type GameDataResource = 'depot' | 'operbox' | 'catalog'
