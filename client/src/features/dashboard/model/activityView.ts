/**
 * 总览当前活动卡的纯展示模型
 *
 * 卡片只消费 `dashboardStore` 的完整快照与刷新状态，不根据名称/代号猜测
 * 加载态。服务端状态、首轮失败、旧 v1 缓存和最近一次刷新失败在这里投影为
 * 明确的 phase；面板只负责渲染。
 */

import type { ActivitySummary } from './snapshot'

export type DashboardActivityPhase = 'loading' | 'active' | 'none' | 'unavailable' | 'stale'

export interface DashboardActivityView {
  phase: DashboardActivityPhase
  title: string
  detail: string
  meta: string
  canRunActivity: boolean
  canRetry: boolean
}

export interface DashboardActivityViewInput {
  summary: ActivitySummary
  hasSnapshot: boolean
  isRefreshing: boolean
  lastRefreshFailed: boolean
  lastRefreshError: string | null
  lastUpdate: number | null
  formatTimestamp?: (timestamp: number) => string
}

const CLIENT_LABELS: Readonly<Record<string, string>> = {
  Official: '官服',
  Bilibili: 'B服',
  YoStarEN: '美服',
  YoStarJP: '日服',
  YoStarKR: '韩服',
  Txwy: '繁中服',
}

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  maa: 'MAA 活动表',
  penguin: '企鹅物流',
}

const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const formatDefaultTimestamp = (timestamp: number): string => TIMESTAMP_FORMATTER.format(timestamp)

const joinParts = (...values: Array<string | null | undefined>): string => (
  values.filter((value): value is string => typeof value === 'string' && value.length > 0).join(' · ')
)

const readOrigin = (summary: ActivitySummary): string => {
  const clientLabel = summary.clientType
    ? CLIENT_LABELS[summary.clientType] ?? summary.clientType
    : ''
  const sourceLabel = summary.source
    ? SOURCE_LABELS[summary.source] ?? summary.source
    : ''
  return joinParts(clientLabel, sourceLabel)
}

/**
 * 把快照与刷新状态投影为卡片视图。
 *
 * `lastRefreshFailed` 只影响“数据是否仍然可信”：没有旧快照时是首轮失败，
 * 有快照时把 none/active 降为 stale；`unavailable` 与服务端 `stale` 保留
 * 各自的原因与重试入口。
 */
export function buildDashboardActivityView(
  input: DashboardActivityViewInput,
): DashboardActivityView {
  const { summary, hasSnapshot, isRefreshing, lastRefreshFailed, lastRefreshError, lastUpdate } = input
  const formatTimestamp = input.formatTimestamp ?? formatDefaultTimestamp
  const origin = readOrigin(summary)
  const updatedAt = summary.dataUpdatedAt !== undefined ? formatTimestamp(summary.dataUpdatedAt) : ''
  const lastSuccessAt = summary.lastSuccessAt ?? lastUpdate
  const lastSuccessText = lastSuccessAt !== null ? `上次成功 ${formatTimestamp(lastSuccessAt)}` : ''
  const lastUpdateText = lastUpdate !== null ? `上次成功 ${formatTimestamp(lastUpdate)}` : ''
  const withRunCapability = (
    view: Omit<DashboardActivityView, 'canRunActivity'>,
  ): DashboardActivityView => ({
    ...view,
    canRunActivity: summary.available === true
      && view.phase !== 'none'
      && view.phase !== 'unavailable',
  })

  if (!hasSnapshot) {
    if (isRefreshing) {
      return withRunCapability({
        phase: 'loading',
        title: '正在获取活动信息',
        detail: '',
        meta: '',
        canRetry: false,
      })
    }
    if (lastRefreshFailed) {
      return withRunCapability({
        phase: 'unavailable',
        title: '活动数据加载失败',
        detail: lastRefreshError || '无法获取活动信息',
        meta: '',
        canRetry: true,
      })
    }
    return withRunCapability({
      phase: 'unavailable',
      title: '无法获取活动信息',
      detail: lastRefreshError || '尚未获取活动信息',
      meta: '',
      canRetry: true,
    })
  }

  if (summary.status === undefined) {
    if (lastRefreshFailed) {
      return withRunCapability({
        phase: 'stale',
        title: '活动信息可能已过期',
        detail: lastRefreshError || '最近一次刷新失败',
        meta: joinParts(origin, lastUpdateText),
        canRetry: true,
      })
    }
    return withRunCapability({
      phase: 'loading',
      title: '正在获取活动信息',
      detail: '',
      meta: '',
      canRetry: false,
    })
  }

  if (summary.status === 'unavailable') {
    return withRunCapability({
      phase: 'unavailable',
      title: '无法获取活动信息',
      detail: summary.failure?.message || summary.message || '未知原因',
      meta: lastUpdateText,
      canRetry: true,
    })
  }

  if (summary.status === 'stale' || lastRefreshFailed) {
    const title = summary.status !== 'none' && (summary.name || summary.code)
      ? (summary.name || summary.code) as string
      : '活动信息可能已过期'
    const detail = lastRefreshFailed
      ? (lastRefreshError || '最近一次刷新失败')
      : (summary.failure?.message || summary.message || '最近一次刷新失败')
    return withRunCapability({
      phase: 'stale',
      title,
      detail,
      meta: joinParts(origin, lastRefreshFailed ? lastUpdateText : lastSuccessText),
      canRetry: true,
    })
  }

  if (summary.status === 'none') {
    return withRunCapability({
      phase: 'none',
      title: '暂无当前刷关活动',
      detail: joinParts(origin, updatedAt ? `更新于 ${updatedAt}` : ''),
      meta: '',
      canRetry: false,
    })
  }

  return withRunCapability({
    phase: 'active',
    title: summary.name || summary.code || '当前活动',
    detail: joinParts(origin, updatedAt ? `更新于 ${updatedAt}` : ''),
    meta: '',
    canRetry: false,
  })
}
