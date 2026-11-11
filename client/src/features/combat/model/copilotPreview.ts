import type { ApiFailureKind } from '@/shared/api'
import type { CopilotRaid, CopilotSetInfo, CopilotSetItem } from '../types'
import { hasCopilotUriScheme, normalizeCopilotInput, parseCopilotUri } from '../utils/copilotUri'
import type { CopilotDetail } from './copilotPayload'

/** 页面的“识别方式”；与作业集执行模式无关。 */
export type CopilotPreviewMode = 'auto' | 'single' | 'set'

/** 实际读取的资源身份；`probe` 是旧的无后缀自动探测。 */
export type CopilotPreviewKind = 'single' | 'set' | 'probe'

export interface CopilotPreviewTarget {
  readonly id: string
  readonly kind: CopilotPreviewKind
  /** 输入没有 s 前缀时为 true；作业集执行时据此改写为 `prts://s<id>`。 */
  readonly autoAddS: boolean
}

export interface CopilotPreviewRequest {
  readonly input: string
  readonly mode: CopilotPreviewMode
  readonly raid: CopilotRaid
}

/**
 * 预览结论：
 * - `ready` 携带可渲染的预览与提示；
 * - `empty` 表示请求成功但没有对应作业/作业集；
 * - `invalid` 表示输入不是可识别的作业 URI，不发起请求；
 * - `failed` 是网络/服务端/载荷失败，页面据此显示错误而不是“不存在”；
 * - `cancelled` 只结束本地等待，不展示为失败。
 */
export type CopilotPreviewOutcome =
  | { readonly status: 'ready'; readonly preview: CopilotSetInfo; readonly message: string }
  | { readonly status: 'empty'; readonly message: string }
  | { readonly status: 'invalid'; readonly message: string }
  | { readonly status: 'failed'; readonly message: string; readonly kind: ApiFailureKind | 'unknown' }
  | { readonly status: 'cancelled' }

export const INVALID_COPILOT_URI_MESSAGE =
  '请输入有效的作业 URI / 作业站链接（如: prts://26766）'

/**
 * 解析输入目标。
 *
 * 旧实现只有在“自动”模式且原始输入不是 `prts://` 开头时才同时探测单作业与
 * 作业集；显式 `prts://1234` 不会被猜测成同 id 的作业集。这里保持同一判定，
 * 因此 prts.plus 链接与本地/其它输入仍走探测，识别方式选择可强制覆盖。
 */
export function resolveCopilotPreviewTarget(
  rawInput: string,
  mode: CopilotPreviewMode,
): CopilotPreviewTarget | null {
  const normalized = normalizeCopilotInput(rawInput).trim()
  const firstToken = normalized.split(/\s+/)[0] ?? ''
  const parsed = parseCopilotUri(firstToken)
  if (!parsed) return null

  const inferred: CopilotPreviewKind = parsed.isSet
    ? 'set'
    : hasCopilotUriScheme(rawInput.trim())
      ? 'single'
      : 'probe'
  return {
    id: parsed.id,
    kind: mode === 'auto' ? inferred : mode,
    autoAddS: !parsed.isSet,
  }
}

export function buildSingleCopilotPreview(id: string, detail: CopilotDetail): CopilotSetInfo {
  return {
    type: 'single',
    id,
    name: detail.title,
    ...(detail.recommendedMode ? { recommendedMode: detail.recommendedMode } : {}),
    ...(detail.stage ? { stage: detail.stage } : {}),
    operators: detail.operators,
    ...(detail.operatorDetails?.length ? { operatorDetails: detail.operatorDetails } : {}),
    ...(detail.groupNames?.length ? { groupNames: detail.groupNames } : {}),
  }
}

export function buildCopilotSetPreview(
  id: string,
  copilots: readonly CopilotSetItem[],
  autoAddS: boolean,
): CopilotSetInfo {
  return {
    type: 'set',
    id,
    name: `作业集 (${copilots.length} 个作业)`,
    note: '包含多个关卡，将按顺序执行',
    autoAddS,
    copilots: [...copilots],
    currentIndex: 0,
  }
}

/** 旧接口同时返回 404/400 时的兜底预览；保留原提示与自动 s 前缀语义。 */
export function buildUnresolvedCopilotSetPreview(id: string, autoAddS: boolean): CopilotSetInfo {
  return {
    type: 'set',
    id,
    name: '作业集',
    note: `当前接口未返回 ${id} 的明细，执行时将按作业集处理${autoAddS ? '（自动添加 s 前缀）' : ''}`,
    autoAddS,
    copilots: [],
    currentIndex: 0,
  }
}

export function buildCopilotSetItemFromDetail(id: number, detail: CopilotDetail): CopilotSetItem {
  return {
    id,
    name: detail.title,
    ...(detail.recommendedMode ? { recommendedMode: detail.recommendedMode } : {}),
    ...(detail.stage ? { stage: detail.stage } : {}),
    operators: detail.operators,
    ...(detail.operatorDetails?.length ? { operatorDetails: detail.operatorDetails } : {}),
    ...(detail.groupNames?.length ? { groupNames: detail.groupNames } : {}),
    uri: `prts://${id}`,
  }
}

/** 单个成员详情不可用时仍保留可执行 id，与旧回退一致。 */
export function buildFallbackCopilotSetItem(id: number): CopilotSetItem {
  return { id, uri: `prts://${id}` }
}
