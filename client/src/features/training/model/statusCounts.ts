/**
 * 养成状态计数纯规则
 *
 * 三种计数沿用迁移前的数据来源：
 * - `trainable` 取候选端点 `status=trainable` 的行数；
 * - `owned` 优先取 `status=owned` 的行数，为空时回退到持有干员快照；
 * - `all` 取全量目录按当前稀有度过滤后的行数，不应用“未精二”条件。
 *
 * 计数读取失败时页面静默保留上一次成功值；`all` 计算为 0 时也不把旧值
 * 覆盖成 0（例如目录暂不可用），由 `mergeTrainingStatusCounts` 保持与
 * 迁移前一致的保护。
 */

import type { TrainingStatusCounts } from '../types'

export const EMPTY_TRAINING_COUNTS: TrainingStatusCounts = {
  trainable: 0,
  owned: 0,
  all: 0,
}

/** 计数只关心稀有度与精英等级；目录、持有干员与候选行都按需传入。 */
export interface CountableOperator {
  rarity?: number
  currentElite?: number
  elite?: number
}

interface CountFilters {
  rarity?: number | null
  needsElite2?: boolean
}

export const countOperatorsByCurrentMetaFilters = (
  rows: readonly CountableOperator[],
  options: CountFilters = {},
): number => rows.filter(operator => {
  if (options.rarity && operator.rarity !== options.rarity) return false
  if (options.needsElite2) {
    const elite = operator.currentElite ?? operator.elite ?? 0
    if (elite >= 2) return false
  }
  return true
}).length

export interface TrainingStatusCountsInput {
  trainableRows: readonly CountableOperator[]
  ownedRows: readonly CountableOperator[]
  catalog: readonly CountableOperator[]
  operBoxRows: readonly CountableOperator[]
  filters: CountFilters
}

export const buildTrainingStatusCounts = ({
  trainableRows,
  ownedRows,
  catalog,
  operBoxRows,
  filters,
}: TrainingStatusCountsInput): TrainingStatusCounts => {
  const owned = ownedRows.length > 0
    ? ownedRows.length
    : countOperatorsByCurrentMetaFilters(operBoxRows, filters)
  const all = countOperatorsByCurrentMetaFilters(catalog, { rarity: filters.rarity })

  return {
    trainable: trainableRows.length,
    owned,
    all,
  }
}

/**
 * 同一筛选身份的重新读取只在 `all` 有正数时更新它；其余字段按最新结果。
 * 与迁移前 `allCount > 0 ? allCount : prev.all` 的保护一致。
 */
export const mergeTrainingStatusCounts = (
  previous: TrainingStatusCounts | undefined,
  next: TrainingStatusCounts,
): TrainingStatusCounts => {
  if (!previous) return next

  const all = next.all > 0 ? next.all : previous.all
  // 值未变化时返回原对象：该函数同时作为 Query 的 structuralSharing，
  // 配合 keepPreviousData 时必须保持引用稳定，否则 pending 占位会反复通知。
  if (previous.trainable === next.trainable && previous.owned === next.owned && previous.all === all) {
    return previous
  }

  return {
    trainable: next.trainable,
    owned: next.owned,
    all,
  }
}
