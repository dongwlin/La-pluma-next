import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import {
  DEFAULT_QUOTES,
  createOperatorQuotesStore,
  createOperatorQuotesService,
  normalizeQuotes
} from '../operatorQuotesService.ts'
import type { OperatorQuotesService } from '../operatorQuotesService.ts'

/** agentError 把结构化字段挂在 Error 上；assert.rejects 的入参是 unknown，按错误形状读取。 */
interface QuoteStorageError extends Error {
  code?: string;
  statusCode?: number;
  retryable?: boolean;
}

function readStorageError(error: unknown): QuoteStorageError {
  return error as QuoteStorageError
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 读回的台词文件是 unknown：JSON 解析后按条目数组收窄供断言使用。 */
function parseStoredQuotes(content: string): unknown[] {
  const parsed: unknown = JSON.parse(content)
  assert.ok(Array.isArray(parsed))
  return parsed
}

test('legacy quotes gain known operator ids without discarding custom entries', () => {
  assert.deepEqual(normalizeQuotes([
    { operator: '银灰', quote: '战术安排已就绪' },
    { operator: '自定义干员', quote: '自定义台词' },
  ]), [
    {
      operatorId: 'char_172_svrash',
      operator: '银灰',
      quote: '战术安排已就绪',
    },
    {
      operatorId: '',
      operator: '自定义干员',
      quote: '自定义台词',
    },
  ])
})

test('store factory rejects a missing or empty quotes path', () => {
  assert.throws(() => createOperatorQuotesStore({} as { quotesPath: string }), TypeError)
  assert.throws(() => createOperatorQuotesStore({ quotesPath: '' }), TypeError)
})

describe('operator quotes service storage behaviour', () => {
  let tempDir: string
  let quotesPath: string
  let quotes: OperatorQuotesService

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'la-pluma-quotes-service-'))
    quotesPath = join(tempDir, 'operatorQuotes.json')
    quotes = createOperatorQuotesService({ store: createOperatorQuotesStore({ quotesPath }) })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('a missing file serves built-in quotes and the first write materializes them', async () => {
    const all = await quotes.getAllQuotes()
    assert.deepEqual(all, DEFAULT_QUOTES)

    const updated = await quotes.addQuote({ operator: '自定义干员', quote: '自定义台词' })
    assert.deepEqual(updated.at(-1), { operator: '自定义干员', quote: '自定义台词' })

    // 缺失文件时的首次写入把兜底文案连同新增一并落盘（与旧实现一致）
    const stored = parseStoredQuotes(await readFile(quotesPath, 'utf-8'))
    assert.equal(stored.length, DEFAULT_QUOTES.length + 1)
    assert.deepEqual(stored.at(-1), { operator: '自定义干员', quote: '自定义台词' })
  })

  test('an empty quotes array is a legal state that serves built-in quotes', async () => {
    await writeFile(quotesPath, '[]', 'utf-8')

    const all = await quotes.getAllQuotes()
    assert.deepEqual(all, DEFAULT_QUOTES)
  })

  test('concurrent modifications of the same file all persist', async () => {
    await writeFile(quotesPath, JSON.stringify([
      { operatorId: 'char_002_amiya', operator: '阿米娅', quote: '旧台词' }
    ]), 'utf-8')

    await Promise.all([
      quotes.addQuote({ operator: '干员一', quote: '台词一' }),
      quotes.addQuote({ operator: '干员二', quote: '台词二' }),
      quotes.updateQuote('阿米娅', '新台词')
    ])

    const stored = parseStoredQuotes(await readFile(quotesPath, 'utf-8'))
    assert.equal(stored.length, 3)
    assert.ok(stored.some(quote => isRecord(quote) && quote.operator === '干员一'))
    assert.ok(stored.some(quote => isRecord(quote) && quote.operator === '干员二'))
    assert.deepEqual(
      stored.find(quote => isRecord(quote) && quote.operator === '阿米娅'),
      { operatorId: 'char_002_amiya', operator: '阿米娅', quote: '新台词' }
    )
  })

  test('updating an existing operator answers the single updated quote', async () => {
    await writeFile(quotesPath, JSON.stringify([
      { operatorId: 'char_002_amiya', operator: '阿米娅', quote: '旧台词' },
      { operatorId: 'char_172_svrash', operator: '银灰', quote: '另一条' }
    ]), 'utf-8')

    const updated = await quotes.updateQuote('阿米娅', '新台词')
    assert.deepEqual(updated, { operatorId: 'char_002_amiya', operator: '阿米娅', quote: '新台词' })

    // 文件写回完整数组，未命中的条目不受影响
    assert.deepEqual(parseStoredQuotes(await readFile(quotesPath, 'utf-8')), [
      { operatorId: 'char_002_amiya', operator: '阿米娅', quote: '新台词' },
      { operatorId: 'char_172_svrash', operator: '银灰', quote: '另一条' }
    ])
  })

  test('updating an unknown operator answers null and leaves the file untouched', async () => {
    await writeFile(quotesPath, JSON.stringify([
      { operatorId: 'char_002_amiya', operator: '阿米娅', quote: '旧台词' }
    ]), 'utf-8')

    assert.equal(await quotes.updateQuote('不存在干员', '台词'), null)

    assert.deepEqual(parseStoredQuotes(await readFile(quotesPath, 'utf-8')), [
      { operatorId: 'char_002_amiya', operator: '阿米娅', quote: '旧台词' }
    ])
  })

  test('a corrupted quotes file fails reads and writes without being overwritten', async () => {
    await writeFile(quotesPath, 'not-json', 'utf-8')

    await assert.rejects(quotes.getAllQuotes(), error => {
      const storageError = readStorageError(error)
      assert.equal(storageError.code, 'AGENT_QUOTES_DATA_INVALID')
      assert.equal(storageError.statusCode, 500)
      assert.equal(storageError.retryable, false)
      assert.match(storageError.message, /读取 JSON 文件失败/)
      return true
    })
    await assert.rejects(quotes.addQuote({ operator: '干员', quote: '台词' }), error => {
      assert.equal(readStorageError(error).code, 'AGENT_QUOTES_DATA_INVALID')
      return true
    })

    // 损坏内容原样保留，不被兜底文案覆盖
    assert.equal(await readFile(quotesPath, 'utf-8'), 'not-json')
  })

  test('a quotes file whose top level is not an array is treated as corrupted', async () => {
    await writeFile(quotesPath, '{"operator":"阿米娅"}', 'utf-8')

    await assert.rejects(quotes.getAllQuotes(), error => {
      const storageError = readStorageError(error)
      assert.equal(storageError.code, 'AGENT_QUOTES_DATA_INVALID')
      assert.match(storageError.message, /台词数据文件顶层不是数组/)
      return true
    })

    assert.equal(await readFile(quotesPath, 'utf-8'), '{"operator":"阿米娅"}')
  })

  test('a write failure rejects with a retryable save error and keeps the original file', async () => {
    const original = JSON.stringify([
      { operatorId: 'char_002_amiya', operator: '阿米娅', quote: '旧台词' }
    ], null, 2)
    await writeFile(quotesPath, original, 'utf-8')
    await chmod(tempDir, 0o555)

    try {
      await assert.rejects(quotes.addQuote({ operator: '干员', quote: '台词' }), error => {
        const storageError = readStorageError(error)
        assert.equal(storageError.code, 'AGENT_QUOTES_SAVE_FAILED')
        assert.equal(storageError.statusCode, 500)
        assert.equal(storageError.retryable, true)
        return true
      })
    } finally {
      await chmod(tempDir, 0o755)
    }

    assert.equal(await readFile(quotesPath, 'utf-8'), original)
  })
})
