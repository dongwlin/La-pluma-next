import { Router } from 'express'
import OperatorQuotes from '../services/operatorQuotesService.ts'
import { asyncHandler } from '../utils/apiHelper.ts'
import type { ApiRequestLike, ApiResponseWriter } from '../utils/apiHelper.ts'
import { parseCreateQuoteBody, parseUpdateQuoteBody } from './operatorQuotesDto.ts'

/**
 * 台词路由：旧裸 JSON 接口，成功返回台词对象或数组，业务失败返回 `{ error }`。
 *
 * 请求体在 operatorQuotesDto 按端点从 unknown 收窄；持久化、归一化与存储
 * 错误码仍由 operatorQuotesService 持有，异步异常继续经 asyncHandler 交给
 * 统一错误出口。URL、状态码与响应形状与类型化前逐项一致。
 */
interface QuoteRequest extends ApiRequestLike {
  body?: unknown;
}

interface QuoteOperatorRequest extends QuoteRequest {
  params: { name: string };
}

const router = Router()

/**
 * 获取今日干员台词
 */
router.get('/daily', asyncHandler<QuoteRequest, ApiResponseWriter>(async (_req, res) => {
  const quote = await OperatorQuotes.getDailyQuote()
  res.json(quote)
}))

/**
 * 获取所有干员台词
 */
router.get('/all', asyncHandler<QuoteRequest, ApiResponseWriter>(async (_req, res) => {
  const quotes = await OperatorQuotes.getAllQuotes()
  res.json(quotes)
}))

/**
 * 随机获取一条台词
 */
router.get('/random', asyncHandler<QuoteRequest, ApiResponseWriter>(async (_req, res) => {
  const quote = await OperatorQuotes.getRandomQuote()
  res.json(quote)
}))

/**
 * 根据干员名获取台词
 */
router.get('/operator/:name', asyncHandler<QuoteOperatorRequest, ApiResponseWriter>(async (req, res) => {
  const { name } = req.params
  const quote = await OperatorQuotes.getQuoteByOperator(name)
  if (quote) {
    res.json(quote)
  } else {
    res.status(404).json({ error: '未找到该干员的台词' })
  }
}))

/**
 * 添加新台词；保存失败经统一错误出口返回，不返回伪成功
 */
router.post('/', asyncHandler<QuoteRequest, ApiResponseWriter>(async (req, res) => {
  const parsed = parseCreateQuoteBody(req.body)
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error })
  }
  const quotes = await OperatorQuotes.addQuote(parsed.value)
  res.json(quotes)
}))

/**
 * 更新台词；保存失败经统一错误出口返回，不返回伪成功
 */
router.put('/operator/:name', asyncHandler<QuoteOperatorRequest, ApiResponseWriter>(async (req, res) => {
  const { name } = req.params
  const parsed = parseUpdateQuoteBody(req.body)
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error })
  }
  const updated = await OperatorQuotes.updateQuote(name, parsed.value)
  if (updated) {
    res.json(updated)
  } else {
    res.status(404).json({ error: '未找到该干员的台词' })
  }
}))

/**
 * 删除台词；保存失败经统一错误出口返回，不返回伪成功
 */
router.delete('/operator/:name', asyncHandler<QuoteOperatorRequest, ApiResponseWriter>(async (req, res) => {
  const { name } = req.params
  const quotes = await OperatorQuotes.deleteQuote(name)
  res.json(quotes)
}))

export default router
