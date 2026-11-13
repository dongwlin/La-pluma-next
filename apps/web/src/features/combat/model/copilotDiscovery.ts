import type { CopilotMatchMode, CopilotSearchOrder } from '../types'
import { normalizeOperatorSelection } from './operatorFilter'

export type { CopilotMatchMode, CopilotMatchSummary, CopilotSearchOrder } from '../types'

export const COPILOT_SEARCH_ORDERS: readonly CopilotSearchOrder[] = ['hot', 'latest', 'views']

export const COPILOT_SEARCH_ORDER_LABELS: Readonly<Record<CopilotSearchOrder, string>> = {
  hot: '热度',
  latest: '最新',
  views: '访问量',
}

export const COPILOT_MATCH_MODES = [
  { mode: 'ready', label: '可直接打' },
  { mode: 'borrow', label: '需助战' },
  { mode: 'train', label: '可培养' },
  { mode: 'check', label: '待确认' },
  { mode: 'blocked', label: '不可打' },
] as const satisfies readonly { mode: CopilotMatchMode; label: string }[]

export const DEFAULT_COPILOT_MATCH_MODES: readonly CopilotMatchMode[] = ['ready', 'borrow', 'train', 'check']

export const isCopilotMatchMode = (value: unknown): value is CopilotMatchMode => (
  value === 'ready' || value === 'borrow' || value === 'train' || value === 'check' || value === 'blocked'
)

export const DEFAULT_COPILOT_SEARCH_LIMIT = 30

export interface CopilotSearchRequest {
  keyword: string
  level: string
  includedOperators: readonly string[]
  excludedOperators: readonly string[]
  orderBy: CopilotSearchOrder
  page: number
  limit: number
}

export interface CopilotSearchRequestInput {
  keyword?: string
  level?: string
  includedOperators?: readonly string[]
  excludedOperators?: readonly string[]
  orderBy?: CopilotSearchOrder
  page?: number
  limit?: number
}

export const isCopilotSearchOrder = (value: unknown): value is CopilotSearchOrder => (
  value === 'hot' || value === 'latest' || value === 'views'
)

const positiveInteger = (value: number | undefined): number | null => (
  typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null
)

export function normalizeCopilotSearchRequest(request: CopilotSearchRequestInput): CopilotSearchRequest {
  const selection = normalizeOperatorSelection({
    included: request.includedOperators ?? [],
    excluded: request.excludedOperators ?? [],
  })
  return {
    keyword: (request.keyword ?? '').trim(),
    level: (request.level ?? '').trim(),
    includedOperators: selection.included,
    excludedOperators: selection.excluded,
    orderBy: isCopilotSearchOrder(request.orderBy) ? request.orderBy : 'hot',
    page: positiveInteger(request.page) ?? 1,
    limit: positiveInteger(request.limit) ?? DEFAULT_COPILOT_SEARCH_LIMIT,
  }
}

export const EMPTY_COPILOT_SEARCH_REQUEST: CopilotSearchRequest = normalizeCopilotSearchRequest({})
