/**
 * 台词 HTTP DTO
 *
 * 把 Express 的未知请求体按端点收窄成台词服务需要的字段；router 只做
 * HTTP 适配，持久化与归一化仍由 operatorQuotesService 持有。
 *
 * 字段规则与文案沿用既有写请求校验：非字符串或空白沿用“缺少……”文案，
 * 超长给出长度文案；合法输入两个端点都按 trim 后传给服务。校验失败仍以
 * 旧 `{ error }` 业务 400 格式返回，因此这里返回结果对象而不是抛统一
 * 信封错误，避免改变台词入口的成功/失败响应形状。
 */

import type { OperatorQuoteDraft } from '../services/operatorQuotesService.ts'

// 写接口的输入边界：字符串、非空（按 trim 判断）与长度上限
const MAX_OPERATOR_NAME_LENGTH = 100
const MAX_QUOTE_LENGTH = 2000

/** 单个文本字段的收窄结果；失败时 error 为旧业务文案。 */
export type QuoteFieldResult =
  | { ok: true; value: string }
  | { ok: false; error: string }

/** 新增台词请求体的收窄结果。 */
export type CreateQuoteParseResult =
  | { ok: true; value: OperatorQuoteDraft }
  | { ok: false; error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 干员名：非字符串或空白沿用既有“缺少”文案，超长给出长度文案，
 * 通过时返回 trim 后的名称。
 */
export function parseOperatorName(operator: unknown): QuoteFieldResult {
  if (typeof operator !== 'string' || !operator.trim()) {
    return { ok: false, error: '缺少干员名或台词' }
  }
  const value = operator.trim()
  if (value.length > MAX_OPERATOR_NAME_LENGTH) {
    return { ok: false, error: `干员名长度不能超过 ${MAX_OPERATOR_NAME_LENGTH} 个字符` }
  }
  return { ok: true, value }
}

/**
 * 台词正文：缺失文案按端点区分（新增沿用“缺少干员名或台词”，
 * 更新为“缺少台词内容”），通过时返回 trim 后的正文。
 */
export function parseQuoteText(quote: unknown, missingMessage: string): QuoteFieldResult {
  if (typeof quote !== 'string' || !quote.trim()) {
    return { ok: false, error: missingMessage }
  }
  const value = quote.trim()
  if (value.length > MAX_QUOTE_LENGTH) {
    return { ok: false, error: `台词长度不能超过 ${MAX_QUOTE_LENGTH} 个字符` }
  }
  return { ok: true, value }
}

/**
 * 新增请求体：旧实现按 `isPlainObject(req.body) ? req.body : {}` 归一，
 * 非对象请求体的“缺少干员名或台词”业务 400 保持不变；干员名先于台词校验，
 * 与旧实现的 `validateOperatorName(...) || validateQuoteText(...)` 顺序一致。
 */
export function parseCreateQuoteBody(body: unknown): CreateQuoteParseResult {
  const source = isPlainObject(body) ? body : {}
  const operator = parseOperatorName(source.operator)
  if (!operator.ok) return operator
  const quote = parseQuoteText(source.quote, '缺少干员名或台词')
  if (!quote.ok) return quote
  return { ok: true, value: { operator: operator.value, quote: quote.value } }
}

/** 更新请求体：只校验台词正文，干员名仍来自路径参数。 */
export function parseUpdateQuoteBody(body: unknown): QuoteFieldResult {
  const source = isPlainObject(body) ? body : {}
  return parseQuoteText(source.quote, '缺少台词内容')
}
