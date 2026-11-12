import { isRecord } from '@/shared/api'
import type {
  CopilotInfoPayload,
  CopilotMatchSummary,
  CopilotPlanPayload,
  CopilotSearchItem,
  CopilotSearchResult,
  CopilotSetItem,
  CopilotSetPayload,
  CopilotStageCandidate,
  ParadoxSearchResult,
} from '../types'
import { copilotDifficultyFromFlags, readCopilotRecommendedMode } from './copilotSelection'
import { isCopilotMatchMode, isCopilotSearchOrder } from './copilotDiscovery'
import {
  asCount,
  asId,
  asNumber,
  asText,
  compactFields,
  readGroupNames,
  readOperatorDetails,
  readOperators,
} from '../utils/copilotPayloadFields'

export type {
  CopilotDetail,
  CopilotInfoPayload,
  CopilotPlanPayload,
  CopilotSetPayload,
} from '../types'

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
  const content = data?.content
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
  const opers = Array.isArray(content.opers) ? content.opers : []
  const groups = Array.isArray(content.groups) ? content.groups : []
  const names = [
    ...opers.map(oper => (isRecord(oper) ? asText(oper.name) : undefined)),
    ...groups.map((group) => {
      const name = isRecord(group) ? asText(group.name) : undefined
      return name ? `[${name}]` : undefined
    }),
  ].filter((name): name is string => Boolean(name))
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

  const documentation = isRecord(content.doc) ? content.doc : null
  const stageId = asText(payload.stageId) ?? asText(content.stage_name)
  const operatorDetails = readOperatorDetails(content.opers)
  const groupNames = readGroupNames(content.groups)
  return {
    statusCode,
    detail: compactFields({
      title: asText(documentation?.title) ?? '未命名作业',
      recommendedMode: copilotDifficultyFromFlags(content.difficulty),
      stage: asText(payload.stage) ?? stageId,
      stageId,
      operators: extractCopilotOperators(content),
      operatorDetails: operatorDetails.length ? operatorDetails : undefined,
      groupNames: groupNames.length ? groupNames : undefined,
      details: asText(documentation?.details),
    }),
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
  const operatorDetails = readOperatorDetails(value.operators)
  const groupNames = readGroupNames(value.groups)
  const completedModes = readCompletedModes(entries, itemIndex)
  return compactFields({
    id,
    name: stage ?? `作业 #${id}`,
    stage,
    stageId: asText(value.stageId),
    apCost: asNumber(value.apCost),
    details: asText(value.details),
    operatorDetails: operatorDetails.length ? operatorDetails : undefined,
    groupNames: groupNames.length ? groupNames : undefined,
    presetFormation: value.presetFormation === true,
    supportsRaid: value.supportsRaid !== false,
    recommendedMode: readCopilotRecommendedMode(value.recommendedMode),
    completedModes: completedModes.length ? completedModes : undefined,
    uri: `prts://${id}`,
  })
}

/** 作业集计划；缺 `items` 或 `entries` 时不可用，调用方回退作业集成员列表。 */
export function readCopilotPlanPayload(value: unknown): CopilotPlanPayload | null {
  const payload = unwrapCopilotPayload(value)
  if (!isRecord(payload) || !Array.isArray(payload.items) || !Array.isArray(payload.entries)) return null

  const entries = payload.entries as readonly unknown[]
  const items = payload.items
    .map((item, index) => readPlanItem(item, index, entries))
    .filter((item): item is CopilotSetItem => item !== null)
  const setId = asText(payload.setId) ?? ''
  const name = asText(payload.name) ?? (setId ? `作业集 ${setId}` : '作业集')
  return { setId, name, items }
}

function readMatch(value: unknown): CopilotMatchSummary | null {
  if (!isRecord(value)) return null
  const mode = value.mode
  const totalSlots = asCount(value.totalSlots)
  if (!isCopilotMatchMode(mode) || totalSlots === null) return null
  return {
    mode,
    missing: readOperators(value.missing),
    training: readOperators(value.training),
    check: readOperators(value.check),
    totalSlots,
  }
}

function readSearchItem(value: unknown): CopilotSearchItem | null {
  if (!isRecord(value)) return null
  const uri = asText(value.uri)
  if (!uri) return null
  const rawId = value.id
  const operators = readOperators(value.operators)
  const operatorDetails = readOperatorDetails(value.operatorDetails)
  const groupNames = readOperators(value.groupNames)
  return compactFields({
    id: typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : uri,
    uri,
    views: asNumber(value.views) ?? 0,
    hotScore: asNumber(value.hotScore) ?? 0,
    stageName: asText(value.stageName),
    stageId: asText(value.stageId),
    stageCode: asText(value.stageCode),
    stageLabel: asText(value.stageLabel),
    title: asText(value.title),
    uploader: asText(value.uploader),
    uploadTime: asText(value.uploadTime),
    operators: operators.length ? operators : undefined,
    match: readMatch(value.match) ?? undefined,
    details: asText(value.details),
    operatorDetails: operatorDetails.length ? operatorDetails : undefined,
    groupNames: groupNames.length ? groupNames : undefined,
    recommendedMode: readCopilotRecommendedMode(value.recommendedMode),
  })
}

function readSearchPayload(value: unknown): Pick<CopilotSearchResult, 'copilots' | 'recommended'> | null {
  const payload = unwrapCopilotPayload(value)
  if (!isRecord(payload) || !Array.isArray(payload.copilots)) return null

  const copilots = payload.copilots
    .map(readSearchItem)
    .filter((item): item is CopilotSearchItem => item !== null)
  const recommendedUri = isRecord(payload.recommended) ? asText(payload.recommended.uri) : undefined
  return { copilots, ...(recommendedUri ? { recommended: { uri: recommendedUri } } : {}) }
}

/** 普通关卡搜索结果；不可用时返回 null，由 Query 转为载荷错误。 */
export function readCopilotSearchResult(value: unknown): CopilotSearchResult | null {
  const payload = readSearchPayload(value)
  if (!payload) return null
  const raw = unwrapCopilotPayload(value)
  const meta = isRecord(raw) ? raw : {}
  return {
    stage: asText(meta.stage) ?? '',
    ...compactFields({
      keyword: asText(meta.keyword),
      stageId: asText(meta.stageId),
      orderBy: isCopilotSearchOrder(meta.orderBy) ? meta.orderBy : undefined,
      page: asCount(meta.page, 1) ?? undefined,
      limit: asCount(meta.limit, 1) ?? undefined,
      total: asCount(meta.total) ?? undefined,
      hasNext: typeof meta.hasNext === 'boolean' ? meta.hasNext : undefined,
    }),
    ...payload,
  }
}

/** 悖论模拟搜索结果；形状与普通搜索一致，只把关卡名换成干员名。 */
export function readParadoxSearchResult(value: unknown): ParadoxSearchResult | null {
  const payload = readSearchPayload(value)
  if (!payload) return null
  const raw = unwrapCopilotPayload(value)
  const operator = isRecord(raw) ? asText(raw.operator) : undefined
  return { operator: operator ?? '', ...payload }
}

function readStageCandidate(value: unknown): CopilotStageCandidate | null {
  if (!isRecord(value)) return null
  const stageId = asText(value.stageId)
  if (!stageId) return null
  return {
    stageId,
    code: asText(value.code) ?? '',
    name: asText(value.name) ?? '',
    category: asText(value.category) ?? '',
    zone: asText(value.zone) ?? '',
  }
}

/** 多候选关卡列表来自错误信封的 `details`；结构不符时按空列表处理。 */
export function readCopilotStageCandidates(value: unknown): CopilotStageCandidate[] {
  if (!isRecord(value) || !Array.isArray(value.candidates)) return []
  return value.candidates
    .map(readStageCandidate)
    .filter((stage): stage is CopilotStageCandidate => stage !== null)
}

/** 关卡目录载荷；非数组表示格式错误，无效项跳过，同一 stageId 只保留首个。 */
export function readCopilotStageCatalog(value: unknown): CopilotStageCandidate[] | null {
  if (!Array.isArray(value)) return null
  const stages: CopilotStageCandidate[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    const stage = readStageCandidate(raw)
    if (!stage || seen.has(stage.stageId)) continue
    seen.add(stage.stageId)
    stages.push(stage)
  }
  return stages
}
