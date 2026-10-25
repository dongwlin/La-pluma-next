/**
 * 养成计划有效期纯规则
 *
 * 一次预览只在生成时的版本前提下有效：
 * - `queueRevision` 是服务端队列成员与精英目标的版本（含命令与外部变化）；
 * - `settingsRevision` 来自 `TrainingSettingsOwner`，设置值每次变化都会递增。
 *
 * 版本不同或队列刷新失败时，页面不得生成新计划，也不得应用旧计划。这里只做
 * 比较与可用性判断，不持有计划、不发起请求；计划生成与应用编排由页面
 * （后续由 FPR-023 的领域所有者）负责。
 */

export interface TrainingPlanBasis {
  readonly queueRevision: string | null
  readonly settingsRevision: number
}

export interface TrainingPlanCurrentBasis {
  readonly queueRevision: string | null
  readonly settingsRevision: number
}

export const captureTrainingPlanBasis = (
  queueRevision: string | null | undefined,
  settingsRevision: number,
): TrainingPlanBasis => ({
  queueRevision: queueRevision ?? null,
  settingsRevision,
})

export const isTrainingPlanBasisCurrent = (
  basis: TrainingPlanBasis,
  current: TrainingPlanCurrentBasis,
): boolean => (
  basis.queueRevision === current.queueRevision
  && basis.settingsRevision === current.settingsRevision
)

export interface GenerateTrainingPlanAvailability {
  readonly hasQueue: boolean
  readonly busy: boolean
  readonly refreshFailed: boolean
}

/** 刷新失败（本地仍有旧快照）时不能生成依赖旧队列的计划。 */
export const canGenerateTrainingPlan = ({
  hasQueue,
  busy,
  refreshFailed,
}: GenerateTrainingPlanAvailability): boolean => hasQueue && !busy && !refreshFailed

export interface ApplyTrainingPlanAvailability {
  readonly hasPlan: boolean
  readonly busy: boolean
  readonly refreshFailed: boolean
  readonly basisCurrent: boolean
}

/** 版本前提变化或刷新失败时旧计划不可应用。 */
export const canApplyTrainingPlan = ({
  hasPlan,
  busy,
  refreshFailed,
  basisCurrent,
}: ApplyTrainingPlanAvailability): boolean => (
  hasPlan && !busy && !refreshFailed && basisCurrent
)
