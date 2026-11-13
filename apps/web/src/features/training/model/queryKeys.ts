import { defineQueryKeys } from '@/shared/query'

export const TRAINING_DOMAIN = 'training' as const

export const trainingKeys = defineQueryKeys(TRAINING_DOMAIN)

export type TrainingResource = 'queue' | 'candidates' | 'counts'
