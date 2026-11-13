import { describe, expect, it } from 'vitest'
import {
  COPILOT_MATCH_MODES,
  COPILOT_SEARCH_ORDER_LABELS,
  COPILOT_SEARCH_ORDERS,
  DEFAULT_COPILOT_MATCH_MODES,
  EMPTY_COPILOT_SEARCH_REQUEST,
  isCopilotMatchMode,
  isCopilotSearchOrder,
  normalizeCopilotSearchRequest,
} from './copilotDiscovery'

describe('copilot discovery vocabulary', () => {
  it('keeps the hot/latest/views order with Chinese labels', () => {
    expect(COPILOT_SEARCH_ORDERS).toEqual(['hot', 'latest', 'views'])
    expect(COPILOT_SEARCH_ORDER_LABELS).toEqual({
      hot: '热度',
      latest: '最新',
      views: '访问量',
    })
  })

  it('lists every match mode in display order and enables the actionable ones', () => {
    expect(COPILOT_MATCH_MODES).toEqual([
      { mode: 'ready', label: '可直接打' },
      { mode: 'borrow', label: '需助战' },
      { mode: 'train', label: '可培养' },
      { mode: 'check', label: '待确认' },
      { mode: 'blocked', label: '不可打' },
    ])
    expect(DEFAULT_COPILOT_MATCH_MODES).toEqual(['ready', 'borrow', 'train', 'check'])
  })

  it('recognizes only the declared order and match values', () => {
    expect(isCopilotSearchOrder('latest')).toBe(true)
    expect(isCopilotSearchOrder('popular')).toBe(false)
    expect(isCopilotMatchMode('blocked')).toBe(true)
    expect(isCopilotMatchMode('readyish')).toBe(false)
  })
})

describe('normalizeCopilotSearchRequest', () => {
  it('trims text, dedupes operators and keeps both sets exclusive', () => {
    expect(normalizeCopilotSearchRequest({
      keyword: '  1-7  ',
      level: ' main_01-07 ',
      includedOperators: ['阿米娅', ' 阿米娅 ', '凯尔希'],
      excludedOperators: [' 桃金娘 ', '桃金娘', '阿米娅'],
      orderBy: 'latest',
      page: 3,
      limit: 15,
    })).toEqual({
      keyword: '1-7',
      level: 'main_01-07',
      includedOperators: ['阿米娅', '凯尔希'],
      excludedOperators: ['桃金娘'],
      orderBy: 'latest',
      page: 3,
      limit: 15,
    })
  })

  it('defaults to the hot first page with 30 items per page', () => {
    expect(EMPTY_COPILOT_SEARCH_REQUEST).toEqual({
      keyword: '',
      level: '',
      includedOperators: [],
      excludedOperators: [],
      orderBy: 'hot',
      page: 1,
      limit: 30,
    })
    expect(normalizeCopilotSearchRequest({})).toEqual(EMPTY_COPILOT_SEARCH_REQUEST)
    expect(normalizeCopilotSearchRequest({ page: 0, limit: -5, orderBy: 'popular' as never }))
      .toMatchObject({ page: 1, limit: 30, orderBy: 'hot' })
  })

  it('accepts a fully empty request so the browse list can load', () => {
    expect(normalizeCopilotSearchRequest({ keyword: '', level: '' })).toEqual(EMPTY_COPILOT_SEARCH_REQUEST)
  })
})
