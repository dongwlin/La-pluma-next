import { defineQueryKeys } from '@/shared/query'

export const COMBAT_DOMAIN = 'combat' as const

export const combatKeys = defineQueryKeys(COMBAT_DOMAIN)

export type CombatResource =
  | 'copilot-search'
  | 'paradox-search'
  | 'copilot'
  | 'copilot-set'
  | 'copilot-set-plan'
