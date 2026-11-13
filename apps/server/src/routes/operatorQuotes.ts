import { Router } from 'express'
import { asyncHandler } from '../utils/apiHelper.ts'
import type { ApiRequestLike, ApiResponseWriter } from '../utils/apiHelper.ts'
import * as operatorQuotesController from '../controllers/operatorQuotesController.ts'

interface QuoteRequest extends ApiRequestLike {
  body?: unknown;
}

interface QuoteOperatorRequest extends QuoteRequest {
  params: { name: string };
}

const router = Router()

router.get('/daily', asyncHandler<QuoteRequest, ApiResponseWriter>(async (_req, res) => {
  res.json(await operatorQuotesController.getDailyQuote())
}))

router.get('/all', asyncHandler<QuoteRequest, ApiResponseWriter>(async (_req, res) => {
  res.json(await operatorQuotesController.getAllQuotes())
}))

router.get('/random', asyncHandler<QuoteRequest, ApiResponseWriter>(async (_req, res) => {
  res.json(await operatorQuotesController.getRandomQuote())
}))

router.get('/operator/:name', asyncHandler<QuoteOperatorRequest, ApiResponseWriter>(async (req, res) => {
  const { name } = req.params
  const lookup = await operatorQuotesController.getQuoteByOperator(name)
  if (!lookup.found) {
    return res.status(lookup.statusCode).json({ error: lookup.error })
  }
  res.json(lookup.quote)
}))

router.post('/', asyncHandler<QuoteRequest, ApiResponseWriter>(async (req, res) => {
  const result = await operatorQuotesController.createQuote(req.body)
  if (!result.ok) {
    return res.status(result.statusCode).json({ error: result.error })
  }
  res.json(result.quotes)
}))

router.put('/operator/:name', asyncHandler<QuoteOperatorRequest, ApiResponseWriter>(async (req, res) => {
  const { name } = req.params
  const result = await operatorQuotesController.updateQuote(name, req.body)
  if (!result.ok) {
    return res.status(result.statusCode).json({ error: result.error })
  }
  res.json(result.quote)
}))

router.delete('/operator/:name', asyncHandler<QuoteOperatorRequest, ApiResponseWriter>(async (req, res) => {
  const { name } = req.params
  res.json(await operatorQuotesController.deleteQuote(name))
}))

export default router
