/**
 * 作业搜索与预览载荷解析
 *
 * 服务端在 `/agent` 信封里返回 PRTS 代理对象；旧调用与测试数据也可能直接给
 * 代理对象本身。这里集中做形状归一，Query 与预览会话只消费归一化后的值：
 *
 * - 搜索：`{ stage|operator, copilots[], recommended }`；条目缺 uri 时丢弃，
 *   `views`/`hotScore` 缺失按 0，`recommended` 只有带 uri 才可用于自动填充。
 * - 单作业：`status_code`/`data.content`（content 是 JSON 字符串或对象）；
 *   `doc.title` 缺失回退“未命名作业”，`opers`/`groups` 拼成展示文本。
 * - 作业集：`data.copilot_ids` 接受数字或数字字符串，只保留正整数。
 * - 作业集计划：`items` 与 `entries` 同时存在；`completed` 的条目按
 *   `itemIndex` 折叠成每个作业的已完成模式。
 */

import { isRecord } from '@/shared/api'
import type {
  CopilotSearchItem,
  CopilotSearchResult,
  CopilotSetItem,
  ParadoxSearchResult,
} from '../types'

export interface CopilotDetail {
  readonly title: string
  readonly stage?: string
  readonly operators: string
}

export interface CopilotInfoPayload {
  /** PRTS 的 `status_code`；非 200 表示作业不存在或代理拒绝。 */
  readonly statusCode: number | null
  readonly detail: CopilotDetail | null
}

export interface CopilotSetPayload {
  readonly statusCode: number | null
  readonly ids: readonly number[]
}

export interface CopilotPlanPayload {
  readonly setId: string
  readonly name: string
  readonly items: readonly CopilotSetItem[]
}

interface CopilotSearchPayload {
  copilots: CopilotSearchItem[]
  recommended?: { uri: string }
}

const asText = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value : undefined
)

const asNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
)

const asId = (value: unknown): number | null => {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : NaN
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null
}

/**
 * 兼容旧调用：`success=true` 时取 `data`，其余（PRTS 代理对象、测试直传的
 * 载荷）原样返回。失败信封不是载荷字段，解析函数会把它当作空结果。
 */
export function unwrapCopilotPayload(value: unknown): unknown {
  if (!isRecord(value)) return value
  if (value.success === true) return value.data
  return value
}

/** 从 PRTS 代理的 `data.content` 读取作业内容；接受已解析对象与 JSON 字符串。 */
function readCopilotContent(payload: Record<string, unknown>): Record<string, unknown> | null {
  const data = isRecord(payload.data) ? payload.data : null
  if (!data) return null
  const content = data.content
  if (isRecord(content)) return content
  if (typeof content !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(content)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 固定干员与干员组按页面既有格式拼接；没有可展示项时为“未知”。 */
export function extractCopilotOperators(content: Record<string, unknown>): string {
  const names: string[] = []
  if (Array.isArray(content.opers)) {
    for (const oper of content.opers) {
      if (!isRecord(oper)) continue
      const name = asText(oper.name)
      if (name) names.push(name)
    }
  }
  if (Array.isArray(content.groups)) {
    for (const group of content.groups) {
      if (!isRecord(group)) continue
      const name = asText(group.name)
      if (name) names.push(`[${name}]`)
    }
  }
  return names.length ? names.join('、') : '未知'
}

/**
 * 单作业详情。只有 `status_code === 200` 且能解析出 content 才视为存在；
 * 其余情况保留 statusCode 供旧的无后缀探测判断回退。
 */
export function readCopilotInfoPayload(value: unknown): CopilotInfoPayload {
  const payload = unwrapCopilotPayload(value)
  if (!isRecord(payload)) return { statusCode: null, detail: null }

  const statusCode = asNumber(payload.status_code)
  if (statusCode !== 200) return { statusCode, detail: null }

  const content = readCopilotContent(payload)
  if (!content) return { statusCode, detail: null }

  const title = asText(isRecord(content.doc) ? content.doc.title : undefined) ?? '未命名作业'
  const stage = asText(content.stage_name)
  return {
    statusCode,
    detail: {
      title,
      ...(stage ? { stage } : {}),
      operators: extractCopilotOperators(content),
    },
  }
}

/** 作业集成员 id；接受数字与数字字符串，丢弃 0、负数与非整数。 */
export function readCopilotSetPayload(value: unknown): CopilotSetPayload {
  const payload = unwrapCopilotPayload(value)
  if (!isRecord(payload)) return { statusCode: null, ids: [] }

  const statusCode = asNumber(payload.status_code)
  const data = isRecord(payload.data) ? payload.data : null
  const rawIds = Array.isArray(data?.copilot_ids) ? data.copilot_ids : []
  const ids: number[] = []
  for (const rawId of rawIds) {
    const id = asId(rawId)
    if (id !== null && !ids.includes(id)) ids.push(id)
  }
  return { statusCode, ids }
}

function readCompletedModes(
  entries: readonly unknown[],
  itemIndex: number,
): Array<'normal' | 'raid'> {
  const modes = new Set<'normal' | 'raid'>()
  for (const entry of entries) {
    if (!isRecord(entry) || entry.completed !== true) continue
    if (asNumber(entry.itemIndex) !== itemIndex) continue
    if (entry.mode === 'normal' || entry.mode === 'raid') modes.add(entry.mode)
  }
  return [...modes]
}

function readPlanItem(
  value: unknown,
  itemIndex: number,
  entries: readonly unknown[],
): CopilotSetItem | null {
  if (!isRecord(value)) return null
  const id = asId(value.id)
  if (id === null) return null

  const stage = asText(value.stage)
  const stageId = asText(value.stageId)
  const completedModes = readCompletedModes(entries, itemIndex)
  return {
    id,
    name: stage ?? `作业 #${id}`,
    ...(stage ? { stage } : {}),
    ...(stageId ? { stageId } : {}),
    presetFormation: value.presetFormation === true,
    supportsRaid: value.supportsRaid !== false,
    ...(completedModes.length ? { completedModes } : {}),
    uri: `prts://${id}`,
  }
}

/** 作业集计划；缺 `items` 或 `entries` 时不可用，调用方回退作业集成员列表。 */
export function readCopilotPlanPayload(value: unknown): CopilotPlanPayload | null {
  const payload = unwrapCopilotPayload(value)
  if (
    !isRecord(payload)
    || !Array.isArray(payload.items)
    || !Array.isArray(payload.entries)
  ) return null

  const entries = payload.entries as readonly unknown[]
  const items = payload.items
    .map((item, index) => readPlanItem(item, index, entries))
    .filter((item): item is CopilotSetItem => item !== null)
  const setId = asText(payload.setId) ?? ''
  const name = asText(payload.name) ?? (setId ? `作业集 ${setId}` : '作业集')
  return { setId, name, items }
}

function readSearchItem(value: unknown): CopilotSearchItem | null {
  if (!isRecord(value)) return null
  const uri = asText(value.uri)
  if (!uri) return null

  const rawId = value.id
  const title = asText(value.title)
  const stageName = asText(value.stageName)
  return {
    id: typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : uri,
    uri,
    views: asNumber(value.views) ?? 0,
    hotScore: asNumber(value.hotScore) ?? 0,
    ...(stageName ? { stageName } : {}),
    ...(title ? { title } : {}),
  }
}

function readSearchPayload(value: unknown): CopilotSearchPayload | null {
  const payload = unwrapCopilotPayload(value)
  if (!isRecord(payload) || !Array.isArray(payload.copilots)) return null

  const copilots = payload.copilots
    .map(readSearchItem)
    .filter((item): item is CopilotSearchItem => item !== null)
  const recommendedUri = isRecord(payload.recommended)
    ? asText(payload.recommended.uri)
    : undefined
  return {
    copilots,
    ...(recommendedUri ? { recommended: { uri: recommendedUri } } : {}),
  }
}

/** 普通关卡搜索结果；不可用时返回 null，由 Query 转为载荷错误。 */
export function readCopilotSearchResult(value: unknown): CopilotSearchResult | null {
  const payload = readSearchPayload(value)
  if (!payload) return null
  const raw = unwrapCopilotPayload(value)
  const stage = isRecord(raw) ? asText(raw.stage) : undefined
  return { stage: stage ?? '', ...payload }
}

/** 悖论模拟搜索结果；形状与普通搜索一致，只把关卡名换成干员名。 */
export function readParadoxSearchResult(value: unknown): ParadoxSearchResult | null {
  const payload = readSearchPayload(value)
  if (!payload) return null
  const raw = unwrapCopilotPayload(value)
  const operator = isRecord(raw) ? asText(raw.operator) : undefined
  return { operator: operator ?? '', ...payload }
}
