import express from 'express'
import OperatorQuotes from '../services/operatorQuotesService.js'

const router = express.Router()

// 写接口的输入边界：字符串、非空（按 trim 判断）与长度上限
const MAX_OPERATOR_NAME_LENGTH = 100
const MAX_QUOTE_LENGTH = 2000

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 添加/更新台词的字段校验；返回 null 表示通过，否则返回旧错误字段文案。
 * 非字符串或空白输入沿用既有“缺少”文案，长度超限给出新文案。
 */
function validateOperatorName(operator) {
  if (typeof operator !== 'string' || !operator.trim()) {
    return '缺少干员名或台词'
  }
  if (operator.trim().length > MAX_OPERATOR_NAME_LENGTH) {
    return `干员名长度不能超过 ${MAX_OPERATOR_NAME_LENGTH} 个字符`
  }
  return null
}

function validateQuoteText(quote, { missingMessage }) {
  if (typeof quote !== 'string' || !quote.trim()) {
    return missingMessage
  }
  if (quote.trim().length > MAX_QUOTE_LENGTH) {
    return `台词长度不能超过 ${MAX_QUOTE_LENGTH} 个字符`
  }
  return null
}

/**
 * 获取今日干员台词
 */
router.get('/daily', (req, res) => {
  const quote = OperatorQuotes.getDailyQuote()
  res.json(quote)
})

/**
 * 获取所有干员台词
 */
router.get('/all', (req, res) => {
  const quotes = OperatorQuotes.getAllQuotes()
  res.json(quotes)
})

/**
 * 随机获取一条台词
 */
router.get('/random', (req, res) => {
  const quote = OperatorQuotes.getRandomQuote()
  res.json(quote)
})

/**
 * 根据干员名获取台词
 */
router.get('/operator/:name', (req, res) => {
  const { name } = req.params
  const quote = OperatorQuotes.getQuoteByOperator(name)
  if (quote) {
    res.json(quote)
  } else {
    res.status(404).json({ error: '未找到该干员的台词' })
  }
})

/**
 * 添加新台词
 */
router.post('/', (req, res) => {
  const body = isPlainObject(req.body) ? req.body : {}
  const { operator, quote } = body
  const invalidReason = validateOperatorName(operator) || validateQuoteText(quote, { missingMessage: '缺少干员名或台词' })
  if (invalidReason) {
    return res.status(400).json({ error: invalidReason })
  }
  const quotes = OperatorQuotes.addQuote({ operator: operator.trim(), quote: quote.trim() })
  res.json(quotes)
})

/**
 * 更新台词
 */
router.put('/operator/:name', (req, res) => {
  const { name } = req.params
  const body = isPlainObject(req.body) ? req.body : {}
  const { quote } = body
  const invalidReason = validateQuoteText(quote, { missingMessage: '缺少台词内容' })
  if (invalidReason) {
    return res.status(400).json({ error: invalidReason })
  }
  const updated = OperatorQuotes.updateQuote(name, quote.trim())
  if (updated) {
    res.json(updated)
  } else {
    res.status(404).json({ error: '未找到该干员的台词' })
  }
})

/**
 * 删除台词
 */
router.delete('/operator/:name', (req, res) => {
  const { name } = req.params
  const quotes = OperatorQuotes.deleteQuote(name)
  res.json(quotes)
})

export default router
