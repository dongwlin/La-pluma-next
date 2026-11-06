import type { OperatorDetailed } from '@/features/game-data'
import type {
  OperatorRecognitionStatus,
  OperatorRecognitionSummary,
  TrainingFilters,
  TrainingOperator,
} from '../types'

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

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const RECOGNITION_STATUSES: readonly OperatorRecognitionStatus[] = ['complete', 'partial', 'missing']

const readFiniteNumber = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : 0
)

/**
 * 读取候选端点附带的识别概要。旧服务端没有该字段时返回 `null`，
 * 由调用方按“未知”处理而不是伪造完整识别。
 */
export const extractOperatorRecognition = (payload: unknown): OperatorRecognitionSummary | null => {
  if (!isRecord(payload) || !isRecord(payload.recognition)) return null
  const recognition = payload.recognition
  const status = recognition.status
  if (typeof status !== 'string' || !RECOGNITION_STATUSES.includes(status as OperatorRecognitionStatus)) {
    return null
  }
  return {
    status: status as OperatorRecognitionStatus,
    recognizedAt: typeof recognition.recognizedAt === 'string' ? recognition.recognizedAt : null,
    total: readFiniteNumber(recognition.total),
    owned: readFiniteNumber(recognition.owned),
    unknown: readFiniteNumber(recognition.unknown),
    missing: Array.isArray(recognition.missing)
      ? recognition.missing.filter((id): id is string => typeof id === 'string')
      : [],
  }
}

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
