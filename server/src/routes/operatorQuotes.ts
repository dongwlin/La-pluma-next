import { Router } from 'express'
import { asyncHandler } from '../utils/apiHelper.ts'
import type { ApiRequestLike, ApiResponseWriter } from '../utils/apiHelper.ts'
import * as operatorQuotesController from '../controllers/operatorQuotesController.ts'

/**
 * 台词路由：旧裸 JSON 接口，只做端点映射与裸 JSON 序列化；成功返回台词
 * 对象或数组，业务失败返回 `{ error }`。
 *
 * 请求体收窄、参数校验与 400/404 判定在 controllers/operatorQuotesController.ts，
 * 持久化、归一化与存储错误码仍由 operatorQuotesService 持有，异步异常继续经
 * asyncHandler 交给统一错误出口。URL、状态码与响应形状与类型化前逐项一致。
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
  res.json(await operatorQuotesController.getDailyQuote())
}))

/**
 * 获取所有干员台词
 */
router.get('/all', asyncHandler<QuoteRequest, ApiResponseWriter>(async (_req, res) => {
  res.json(await operatorQuotesController.getAllQuotes())
}))

/**
 * 随机获取一条台词
 */
router.get('/random', asyncHandler<QuoteRequest, ApiResponseWriter>(async (_req, res) => {
  res.json(await operatorQuotesController.getRandomQuote())
}))

/**
 * 根据干员名获取台词
 */
router.get('/operator/:name', asyncHandler<QuoteOperatorRequest, ApiResponseWriter>(async (req, res) => {
  const { name } = req.params
  const lookup = await operatorQuotesController.getQuoteByOperator(name)
  if (!lookup.found) {
    return res.status(lookup.statusCode).json({ error: lookup.error })
  }
  res.json(lookup.quote)
}))

/**
 * 添加新台词；保存失败经统一错误出口返回，不返回伪成功
 */
router.post('/', asyncHandler<QuoteRequest, ApiResponseWriter>(async (req, res) => {
  const result = await operatorQuotesController.createQuote(req.body)
  if (!result.ok) {
    return res.status(result.statusCode).json({ error: result.error })
  }
  res.json(result.quotes)
}))

/**
 * 更新台词；保存失败经统一错误出口返回，不返回伪成功
 */
router.put('/operator/:name', asyncHandler<QuoteOperatorRequest, ApiResponseWriter>(async (req, res) => {
  const { name } = req.params
  const result = await operatorQuotesController.updateQuote(name, req.body)
  if (!result.ok) {
    return res.status(result.statusCode).json({ error: result.error })
  }
  res.json(result.quote)
}))

/**
 * 删除台词；保存失败经统一错误出口返回，不返回伪成功
 */
router.delete('/operator/:name', asyncHandler<QuoteOperatorRequest, ApiResponseWriter>(async (req, res) => {
  const { name } = req.params
  res.json(await operatorQuotesController.deleteQuote(name))
}))

export default router
