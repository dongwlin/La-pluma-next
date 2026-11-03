import OperatorQuotes from '../services/operatorQuotesService.ts'
import type { OperatorQuote, StoredOperatorQuote } from '../services/operatorQuotesService.ts'
import { parseCreateQuoteBody, parseUpdateQuoteBody } from './operatorQuotesDto.ts'

export async function getDailyQuote(): Promise<OperatorQuote> {
  return OperatorQuotes.getDailyQuote()
}

export async function getAllQuotes(): Promise<OperatorQuote[]> {
  return OperatorQuotes.getAllQuotes()
}

export async function getRandomQuote(): Promise<OperatorQuote> {
  return OperatorQuotes.getRandomQuote()
}

/** 单条台词查询出口：命中携带台词对象，未命中携带旧业务 404 文案。 */
export type QuoteLookup =
  | { found: true; quote: OperatorQuote }
  | { found: false; statusCode: 404; error: string }

/**
 * 根据干员名获取台词；未命中保持旧业务文案与 404，由路由层应用状态码。
 */
export async function getQuoteByOperator(name: string): Promise<QuoteLookup> {
  const quote = await OperatorQuotes.getQuoteByOperator(name)
  if (quote) {
    return { found: true, quote }
  }
  return { found: false, statusCode: 404, error: '未找到该干员的台词' }
}

/** 新增台词出口：校验失败携带旧业务 400 文案，成功携带保存后的全量台词。 */
export type CreateQuoteResult =
  | { ok: true; quotes: StoredOperatorQuote[] }
  | { ok: false; statusCode: 400; error: string }

/**
 * 添加新台词；保存失败经统一错误出口返回，不返回伪成功
 */
export async function createQuote(body: unknown): Promise<CreateQuoteResult> {
  const parsed = parseCreateQuoteBody(body)
  if (!parsed.ok) {
    return { ok: false, statusCode: 400, error: parsed.error }
  }
  return { ok: true, quotes: await OperatorQuotes.addQuote(parsed.value) }
}

/** 更新台词出口：校验失败为 400，目标干员不存在为 404，均携带旧业务文案。 */
export type UpdateQuoteResult =
  | { ok: true; quote: OperatorQuote }
  | { ok: false; statusCode: 400 | 404; error: string }

export async function updateQuote(name: string, body: unknown): Promise<UpdateQuoteResult> {
  const parsed = parseUpdateQuoteBody(body)
  if (!parsed.ok) {
    return { ok: false, statusCode: 400, error: parsed.error }
  }
  const updated = await OperatorQuotes.updateQuote(name, parsed.value)
  if (updated) {
    return { ok: true, quote: updated }
  }
  return { ok: false, statusCode: 404, error: '未找到该干员的台词' }
}

export async function deleteQuote(name: string): Promise<OperatorQuote[]> {
  return OperatorQuotes.deleteQuote(name)
}
