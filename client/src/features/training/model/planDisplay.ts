/**
 * 养成计划展示纯规则
 *
 * “当日开放关卡”的取法同时决定页面展示与应用提交：优先使用服务端
 * `openStages`，缺失时回退到 `stages` 中 `isOpen !== false` 的条目。
 * 今日次数、理智与焦点干员都由计划快照派生，面板不复制这些规则。
 */

import type { TrainingPlan, TrainingQueueItem } from '../types'

/**
 * 只保留当日开放关卡。`openStages` 存在（包括空数组）时以它为准，
 * 否则按 `isOpen !== false` 过滤完整关卡列表。
 */
export const getOpenStagePlan = (sourcePlan: TrainingPlan): TrainingPlan => ({
  ...sourcePlan,
  stages: sourcePlan.openStages
    ?? sourcePlan.stages?.filter(stage => stage.isOpen !== false)
    ?? [],
})

export type TrainingPlanStages = NonNullable<TrainingPlan['stages']>

export const selectTodayStages = (plan: TrainingPlan | null): TrainingPlanStages =>
  plan ? getOpenStagePlan(plan).stages ?? [] : []

/** 今日可刷关卡数；空计划返回 0。 */
export const getOpenStageCount = (plan: TrainingPlan | null): number => {
  if (!plan) return 0
  return plan.openStages?.length
    ?? plan.stages?.filter(stage => stage.isOpen !== false).length
    ?? 0
}

export interface TodayPlanSummary {
  stages: TrainingPlanStages
  openStageCount: number
  runCount: number
  /** 今日开放关卡的理智合计；未提供 `sanityPerRun` 的关卡按 0 计。 */
  sanity: number
}

/**
 * 今日计划摘要。理智需要回查完整 `stages`，因为 `openStages` 条目
 * 不携带 `sanityPerRun`；同一关卡出现多次时按 `stage` 标识匹配。
 */
export const summarizeTodayPlan = (plan: TrainingPlan | null): TodayPlanSummary => {
  const stages = selectTodayStages(plan)
  const runCount = stages.reduce((sum, stage) => sum + Number(stage.totalTimes ?? 0), 0)
  const sanity = stages.reduce((total, stage) => (
    total + (plan?.stages?.find(entry => entry.stage === stage.stage)?.sanityPerRun ?? 0)
      * Number(stage.totalTimes ?? 0)
  ), 0)

  return {
    stages,
    openStageCount: getOpenStageCount(plan),
    runCount,
    sanity,
  }
}

/** 计划焦点：服务端焦点干员 → 计划首位干员 → 队列当前目标 → 未设置。 */
export const getPlanFocusName = (
  plan: TrainingPlan | null,
  currentTarget: TrainingQueueItem | null,
): string => plan?.focusOperator?.name
  || plan?.operators?.[0]?.name
  || currentTarget?.operator.name
  || '未设置'
