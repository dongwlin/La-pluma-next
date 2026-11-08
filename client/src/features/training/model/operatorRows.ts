import type { TrainingFilters, TrainingOperator } from '../types'
import type { OperatorProfessionFilter } from './operatorSelection'

/** 选择器一次渲染的干员行数；与迁移前的页面常量一致。 */
export const OPERATOR_RENDER_BATCH_SIZE = 72

export const normalizeOperatorSearchTerm = (term: string): string =>
  term.trim().toLowerCase()

/**
 * 按名称包含匹配；空搜索返回全部行。返回新数组，避免调用方误改查询快照。
 */
export const filterOperatorRows = <T extends { name: string }>(
  operators: readonly T[],
  searchTerm: string,
): T[] => {
  const normalizedTerm = normalizeOperatorSearchTerm(searchTerm)
  if (!normalizedTerm) return [...operators]
  return operators.filter(operator => operator.name.toLowerCase().includes(normalizedTerm))
}

export interface VisibleOperatorRows<T> {
  rows: T[]
  hiddenCount: number
}

export const paginateOperatorRows = <T>(
  operators: readonly T[],
  limit: number,
): VisibleOperatorRows<T> => {
  const safeLimit = Math.max(0, Math.floor(limit))
  const rows = operators.slice(0, safeLimit)
  return {
    rows,
    hiddenCount: Math.max(operators.length - rows.length, 0),
  }
}

/** “继续显示”每次增加一个批次；至少推进 1，避免 limit 为 0 或负数时卡住。 */
export const nextOperatorRenderLimit = (limit: number): number =>
  Math.max(0, Math.floor(limit)) + OPERATOR_RENDER_BATCH_SIZE

export interface OperatorEmptyState {
  title: string
  description: string
}

/**
 * 候选为空时的提示。搜索/职业/稀有度优先于状态，与迁移前的页面分支顺序一致。
 */
export const resolveOperatorEmptyState = (
  filters: Pick<TrainingFilters, 'status' | 'rarity'>,
  searchTerm: string,
  profession: OperatorProfessionFilter = 'all',
): OperatorEmptyState => {
  if (normalizeOperatorSearchTerm(searchTerm) || filters.rarity || profession !== 'all') {
    return {
      title: '没有找到符合条件的干员',
      description: '换个名称、职业、稀有度或状态筛选再试。',
    }
  }

  if (filters.status === 'trainable') {
    return {
      title: '没有可养成干员',
      description: '当前没有可直接加入队列的干员，可以切到“已拥有”或“全部”查看其他状态。',
    }
  }

  if (filters.status === 'owned') {
    return {
      title: '还没有已拥有干员',
      description: '请先在“数据统计”页面识别干员，或切到“全部”查看完整干员列表。',
    }
  }

  return {
    title: '没有干员数据',
    description: '全量干员数据暂不可用，请先更新资源或稍后重试。',
  }
}

export interface OperatorRowState {
  isOwned: boolean
  canAdd: boolean
  actionLabel: string
}

/**
 * 卡片动作与蒙版状态。已入队优先于未识别/未拥有/缺数据；识别未确认的干员
 * 不能标成“未拥有”，`disabledReason` 只在可训练但已经精二时影响文案。
 */
export const describeOperatorRow = (
  operator: TrainingOperator,
  isInQueue: boolean,
): OperatorRowState => {
  const isUnrecognized = operator.ownership === 'unknown'
  const isOwned = operator.owned !== false
  const isAlreadyElite2 = operator.disabledReason === 'already_elite2'
  const canAdd = Boolean(operator.canTrain) && !isInQueue
  const actionLabel = isInQueue
    ? '已添加'
    : isUnrecognized
      ? '未识别'
      : !isOwned
        ? '未拥有'
        : !operator.hasMaterialData
          ? '暂无数据'
          : isAlreadyElite2
            ? '已完成'
            : '添加'

  return { isOwned, canAdd, actionLabel }
}
