/**
 * 养成候选列表纯规则
 *
 * 候选列表以 `/agent/training/operators` 的返回为主；旧服务端在
 * `status=all` 返回空列表时，页面此前会用共享干员目录与持有干员快照补齐。
 * 该补齐规则不依赖 React，放在领域模型里直接测试，页面只消费 Query 结果。
 *
 * 旧载荷兼容：端点允许返回 `operators` 数组或顶层数组；补齐路径中持有干员
 * 与目录都是共享资源域已经归一过的数组。
 */

import type { OperatorDetailed } from '@/features/game-data'
import type { TrainingFilters, TrainingOperator } from '../types'

export interface TrainingCandidateFilters {
  status: TrainingFilters['status']
  /** 缺失或 `null` 表示不按稀有度筛选；不混用 `undefined` 与省略两种身份。 */
  rarity?: number | null
  needsElite2?: boolean
}

/** 端点旧载荷可能携带目录字段；只用于读取，不在此建立第二份类型归属。 */
type CandidateRow = Partial<TrainingOperator> & {
  elite?: number
  level?: number
}

const rawOperatorRows = (payload: unknown): CandidateRow[] => {
  const data = payload as
    | { operators?: CandidateRow[]; data?: CandidateRow[] }
    | CandidateRow[]
    | null
    | undefined
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.operators)) return data.operators
  if (Array.isArray(data?.data)) return data.data
  return []
}

/**
 * 从候选人端点载荷读取行。端点已校验数组或 `operators` 数组，
 * 这里只兼容字段缺失，保持页面迁移前的宽松读取。
 */
export const extractOperatorRows = (payload: unknown): TrainingOperator[] =>
  rawOperatorRows(payload) as TrainingOperator[]

/**
 * `status=all` 端点为空的兼容补齐：用全量目录与持有干员快照重建候选行。
 * 这些行没有材料数据，因此标记为不可养成；稀有度仍按请求筛选，
 * “未精二”条件与迁移前一致地不作用于补齐行。
 */
export const buildAllCandidateRows = (
  catalog: readonly OperatorDetailed[],
  ownedOperators: readonly OperatorDetailed[],
  rarity?: number | null,
): TrainingOperator[] => {
  const ownedMap = new Map(ownedOperators.map(operator => [operator.id, operator]))

  return catalog
    .filter(operator => !rarity || operator.rarity === rarity)
    .map(operator => {
      const ownedOperator = ownedMap.get(operator.id)
      const owned = Boolean(ownedOperator)
      const disabledReason = owned ? 'missing_material_data' : 'unowned'

      return {
        id: operator.id || '',
        name: ownedOperator?.name || operator.name || '未知干员',
        rarity: ownedOperator?.rarity ?? operator.rarity ?? 0,
        profession: operator.profession || ownedOperator?.profession || '未知',
        currentElite: owned ? (ownedOperator?.elite || 0) : 0,
        currentLevel: owned ? (ownedOperator?.level || 1) : 0,
        targetElite: 2,
        owned,
        hasMaterialData: false,
        canTrain: false,
        disabledReason,
        trainingStatus: disabledReason,
      }
    })
}
