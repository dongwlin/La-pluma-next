/**
 * 干员台词服务
 * 从 PRTS Wiki 获取干员语音记录（本文件仅承载内置兜底文案与可选的用户自定义文件）
 *
 * 存储契约（用户自定义文件 server/data/operatorQuotes.json）：
 * - 文件缺失：视为尚未自定义，读取返回内置兜底文案；首次写入把兜底文案连同变更一并落盘。
 * - 文件为合法 JSON 数组且归一后非空：条目即用户自定义台词。
 * - 文件为合法 JSON 数组但归一后为空（如删除全部台词后的 `[]`）：合法空状态，读取返回内置兜底文案。
 * - 文件存在但解析失败或顶层不是数组：视为损坏——读取与写入一律报错，绝不用兜底文案
 *   覆盖原文件，损坏内容保留待人工处置。
 *
 * 全部 IO 为异步；读改写整体在同一路径排队单元内执行（fileHelper），
 * 并发修改互不丢失，写回为临时文件原子替换。
 */

import { readJsonFile, updateJsonFile } from '../utils/fileHelper.ts'
import { agentError } from '../utils/apiHelper.ts'
import { join } from 'path'
import { fileURLToPath } from 'url'

// 数据目录按模块位置锚定，与 cwd 无关；`LA_PLUMA_OPERATOR_QUOTES_STORE`
// 可重定向存储位置（测试隔离与部署需要），默认路径保持 server/data/operatorQuotes.json。
const dataDir = fileURLToPath(new URL('../data/', import.meta.url))

/**
 * 创建绑定单一台词 JSON 文件的存储实例。
 *
 * @param {object} options
 * @param {string} options.quotesPath 台词文件的绝对路径。
 * @returns {{
 *   path: string,
 *   load: () => Promise<unknown>,
 *   update: (updateFn: (current: unknown) => unknown | Promise<unknown>) => Promise<unknown>
 * }}
 */
export function createOperatorQuotesStore({ quotesPath }) {
  if (typeof quotesPath !== 'string' || !quotesPath) {
    throw new TypeError('quotesPath 必须是非空字符串')
  }

  return {
    path: quotesPath,
    // 缺失文件按 null 返回（由服务层决定兜底语义）；解析失败抛“读取 JSON 文件失败”。
    load: () => readJsonFile(quotesPath, null),
    // 读改写整体在同一排队单元内执行：并发修改互不丢失，写回为临时文件原子替换，
    // 失败时保留原文件内容。updateFn 抛出错误即中断本次读改写且不产生写入。
    update: updateFn => updateJsonFile(quotesPath, updateFn, null)
  }
}

// 默认存储在导入时绑定路径；测试进程通过环境变量在导入前注入临时目录。
const defaultStore = createOperatorQuotesStore({
  quotesPath: process.env.LA_PLUMA_OPERATOR_QUOTES_STORE || join(dataDir, 'operatorQuotes.json')
})

// 内置兜底文案（当数据文件缺失或为空时使用）
// 这些是项目内置兜底文案，不作为官方语音记录。
const OPERATOR_IDS = {
  阿米娅: 'char_002_amiya',
  凯尔希: 'char_003_kalts',
  陈: 'char_010_chen',
  煌: 'char_017_huang',
  德克萨斯: 'char_102_texas',
  能天使: 'char_103_angel',
  推进之王: 'char_112_siege',
  W: 'char_113_cqbw',
  星熊: 'char_136_hsguma',
  拉普兰德: 'char_140_whitew',
  银灰: 'char_172_svrash',
  艾雅法拉: 'char_180_amgoat',
  塞雷娅: 'char_202_demkni',
  令: 'char_2023_ling',
  棘刺: 'char_293_thorns',
  史尔特尔: 'char_350_surtr',
  澄闪: 'char_377_gdglow'
}

const DEFAULT_QUOTES = [
  { operatorId: OPERATOR_IDS.阿米娅, operator: '阿米娅', quote: '今天也请多指教' },
  { operatorId: OPERATOR_IDS.凯尔希, operator: '凯尔希', quote: '作战记录已归档' },
  { operatorId: OPERATOR_IDS.陈, operator: '陈', quote: '任务简报已经确认' },
  { operatorId: OPERATOR_IDS.煌, operator: '煌', quote: '队伍状态不错' },
  { operatorId: OPERATOR_IDS.能天使, operator: '能天使', quote: '补给检查完成' },
  { operatorId: OPERATOR_IDS.银灰, operator: '银灰', quote: '战术安排已就绪' },
  { operatorId: OPERATOR_IDS.艾雅法拉, operator: '艾雅法拉', quote: '数据采集稳定' },
  { operatorId: OPERATOR_IDS.塞雷娅, operator: '塞雷娅', quote: '防护流程正常' },
  { operatorId: OPERATOR_IDS.星熊, operator: '星熊', quote: '防线已经架好' },
  { operatorId: OPERATOR_IDS.推进之王, operator: '推进之王', quote: '行动前先确认队形' },
  { operatorId: OPERATOR_IDS.德克萨斯, operator: '德克萨斯', quote: '通讯频道保持畅通' },
  { operatorId: OPERATOR_IDS.拉普兰德, operator: '拉普兰德', quote: '这次行动会很有趣' },
  { operatorId: OPERATOR_IDS.令, operator: '令', quote: '今日也宜从容落子' },
  { operatorId: OPERATOR_IDS.棘刺, operator: '棘刺', quote: '药剂和装备都已备齐' },
  { operatorId: OPERATOR_IDS.史尔特尔, operator: '史尔特尔', quote: '别让目标等太久' },
  { operatorId: OPERATOR_IDS.W, operator: 'W', quote: '装置都在正确位置' },
  { operatorId: OPERATOR_IDS.澄闪, operator: '澄闪', quote: '信号稳定，可以开始' }
]

export function normalizeQuotes(quotes) {
  if (!Array.isArray(quotes)) return []

  return quotes
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const operator = String(item.operator || '').trim()
      const operatorId = String(item.operatorId || OPERATOR_IDS[operator] || '').trim()

      return {
        operatorId,
        operator,
        quote: String(item.quote || '').trim()
      }
    })
    .filter((item) => item.operator && item.quote)
}

export { DEFAULT_QUOTES }

// 用户文件损坏（顶层不是数组）的可识别标记；解析失败由 fileHelper 抛出。
class QuotesFileInvalidError extends Error {
  constructor(message) {
    super(message)
    this.name = 'QuotesFileInvalidError'
  }
}

// 读改写内部哨兵：目标干员不存在时中断本次读改写且不产生任何写入。
const QUOTE_NOT_FOUND = Symbol('quote-not-found')

function resolveStoredQuotes(raw) {
  // 缺失文件（null）与合法空数组都回退内置兜底文案。
  if (raw === null) return DEFAULT_QUOTES
  if (!Array.isArray(raw)) {
    throw new QuotesFileInvalidError('台词数据文件顶层不是数组')
  }
  const quotes = normalizeQuotes(raw)
  return quotes.length > 0 ? quotes : DEFAULT_QUOTES
}

function isQuotesFileReadError(error) {
  // fileHelper 的 JSON 读取/解析失败统一携带该前缀（fileHelper.readJsonFile）。
  return error instanceof Error && error.message.startsWith('读取 JSON 文件失败')
}

/**
 * 存储失败的结构化出口：损坏文件不重试，写入失败允许重试。
 */
function wrapQuotesStorageError(error) {
  if (error instanceof QuotesFileInvalidError || isQuotesFileReadError(error)) {
    return agentError('AGENT_QUOTES_DATA_INVALID', error.message, {
      statusCode: 500,
      retryable: false
    })
  }
  return agentError('AGENT_QUOTES_SAVE_FAILED', `保存台词数据失败: ${error?.message || error}`, {
    statusCode: 500,
    retryable: true
  })
}

/**
 * 创建台词服务实例。存储经参数注入；生产使用默认存储，测试注入指向临时目录的实例。
 *
 * @param {object} options
 * @param {ReturnType<typeof createOperatorQuotesStore>} options.store 台词 JSON 文件存储。
 */
export function createOperatorQuotesService({ store }) {
  if (!store || typeof store.load !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('store 必须提供 load 与 update')
  }

  async function loadQuotes() {
    try {
      return resolveStoredQuotes(await store.load())
    } catch (error) {
      throw wrapQuotesStorageError(error)
    }
  }

  return {
    loadQuotes,

    async getAllQuotes() {
      return loadQuotes()
    },

    async getDailyQuote() {
      const quotes = await loadQuotes()
      const today = new Date()
      const dayOfYear = Math.floor((today.getTime() - new Date(today.getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24))
      return quotes[dayOfYear % quotes.length]
    },

    async getRandomQuote() {
      const quotes = await loadQuotes()
      const randomIndex = Math.floor(Math.random() * quotes.length)
      return quotes[randomIndex] || DEFAULT_QUOTES[0]
    },

    async getQuoteByOperator(operatorName) {
      const quotes = await loadQuotes()
      return quotes.find(q => q.operator === operatorName)
    },

    async addQuote(quote) {
      try {
        return await store.update(current => [...resolveStoredQuotes(current), quote])
      } catch (error) {
        throw wrapQuotesStorageError(error)
      }
    },

    async updateQuote(operatorName, newQuote) {
      let updatedQuote = null
      try {
        // 文件写回完整数组，返回值保持旧契约：命中的单条更新结果。
        await store.update(current => {
          const quotes = resolveStoredQuotes(current)
          const index = quotes.findIndex(q => q.operator === operatorName)
          if (index === -1) throw QUOTE_NOT_FOUND
          updatedQuote = { ...quotes[index], quote: newQuote }
          return quotes.map((quote, position) => (position === index ? updatedQuote : quote))
        })
        return updatedQuote
      } catch (error) {
        if (error === QUOTE_NOT_FOUND) return null
        throw wrapQuotesStorageError(error)
      }
    },

    async deleteQuote(operatorName) {
      try {
        return await store.update(current => resolveStoredQuotes(current).filter(q => q.operator !== operatorName))
      } catch (error) {
        throw wrapQuotesStorageError(error)
      }
    }
  }
}

const OperatorQuotes = createOperatorQuotesService({ store: defaultStore })

export default OperatorQuotes
