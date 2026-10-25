/**
 * 养成域 Query key
 *
 * 域标识 `training` 与 feature 目录一致；队列、候选列表与三种状态计数分别使用
 * `queue`、`candidates`、`counts` 资源名。影响响应的筛选参数进入 key：候选列表
 * 包含状态，候选与计数都包含稀有度与“未精二”条件，缺失值统一为 `null`。
 */

import { defineQueryKeys } from '@/shared/query'

export const TRAINING_DOMAIN = 'training' as const

export const trainingKeys = defineQueryKeys(TRAINING_DOMAIN)

export type TrainingResource = 'queue' | 'candidates' | 'counts'
