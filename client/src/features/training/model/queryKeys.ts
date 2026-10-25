/**
 * 养成域 Query key
 *
 * 域标识 `training` 与 feature 目录一致；候选列表与三种状态计数分别使用
 * `candidates`、`counts` 资源名。影响响应的筛选参数进入 key：候选列表包含
 * 状态，两个资源都包含稀有度与“未精二”条件，缺失值统一为 `null`。
 * 队列与计划仍由页面（以及后续队列任务）持有，暂不在此声明 key。
 */

import { defineQueryKeys } from '@/shared/query'

export const TRAINING_DOMAIN = 'training' as const

export const trainingKeys = defineQueryKeys(TRAINING_DOMAIN)

export type TrainingResource = 'candidates' | 'counts'
