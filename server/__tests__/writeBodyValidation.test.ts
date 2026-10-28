import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { RequestListener, Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createLaPlumaApp } from '../server.ts'
import { setConfigStorageDirForTests } from '../services/configStorageService.ts'
import OperatorQuotes from '../services/operatorQuotesService.ts'
import type { OperatorQuote, OperatorQuoteDraft, StoredOperatorQuote } from '../services/operatorQuotesService.ts'

const servers: Server[] = []
const tempDirs: string[] = []

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function listen(app: RequestListener): Promise<number> {
  const server = createServer(app)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('监听端口获取失败')
  }
  return address.port
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function useTempConfigStorage(): Promise<string> {
  const dir = await makeTempDir('la-pluma-config-http-')
  setConfigStorageDirForTests(dir)
  return dir
}

async function readJson(response: Response): Promise<JsonRecord> {
  const body: unknown = await response.json()
  assert.ok(isRecord(body), '响应应为 JSON 对象')
  return body
}

/** 统一错误信封的 error 字段；调用方逐项断言码、可重试位与 details。 */
function readError(payload: JsonRecord): JsonRecord {
  const error = payload.error
  assert.ok(isRecord(error), '错误信封应包含 error 对象')
  return error
}

/**
 * 存储间谍：记录路由传入台词服务的写入载荷；测试结束后恢复原实现。
 * 服务方法已异步化，真实存储行为由台词持久化 HTTP 回归覆盖。
 */
function spyQuoteStorage(): { saveCalls: unknown[]; restore(): void } {
  const originalAddQuote = OperatorQuotes.addQuote
  const originalUpdateQuote = OperatorQuotes.updateQuote
  const saveCalls: unknown[] = []
  OperatorQuotes.addQuote = async (quote: OperatorQuoteDraft): Promise<StoredOperatorQuote[]> => {
    saveCalls.push(quote)
    return [quote]
  }
  OperatorQuotes.updateQuote = async (name: string, quote: string): Promise<OperatorQuote | null> => {
    saveCalls.push({ name, quote })
    return { operatorId: '', operator: name, quote }
  }
  return {
    saveCalls,
    restore() {
      OperatorQuotes.addQuote = originalAddQuote
      OperatorQuotes.updateQuote = originalUpdateQuote
    }
  }
}

afterEach(async () => {
  setConfigStorageDirForTests(null)
  while (servers.length) {
    const server = servers.pop()
    assert.ok(server)
    server.closeIdleConnections?.()
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  while (tempDirs.length) await rm(tempDirs.pop() as string, { recursive: true, force: true })
})

describe('user config write body boundaries', () => {
  it('answers non-object config bodies with a business 400 and never writes', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    const storageDir = await useTempConfigStorage()
    const url = `http://127.0.0.1:${port}/api/agent/config/user/auto-update`

    // JSON 顶层原始值在解析层即被统一错误出口拒绝
    for (const body of ['"text"', 'null']) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body
      })
      assert.equal(response.status, 400)
      const payload = await readJson(response)
      assert.equal(payload.success, false)
      assert.equal(readError(payload).code, 'AGENT_REQUEST_BODY_INVALID')
    }

    // JSON 数组能被解析器接受，但会在写入前被顶层校验拒绝
    const arrayResponse = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[1,2,3]'
    })
    assert.equal(arrayResponse.status, 400)
    const arrayPayload = await readJson(arrayResponse)
    assert.equal(arrayPayload.success, false)
    const arrayError = readError(arrayPayload)
    assert.equal(arrayError.code, 'AGENT_CONFIG_DATA_INVALID')
    assert.equal(arrayError.retryable, false)
    assert.deepEqual(await readdir(storageDir), [])

    // 全局 JSON 解析器把缺失 body 归一为空对象：按既有行为视为合法的空配置
    const noBody = await fetch(url, { method: 'POST' })
    assert.equal(noBody.status, 200)
    assert.equal((await readJson(noBody)).success, true)
  })

  it('saves valid legacy payloads with extension fields end to end', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    await useTempConfigStorage()
    const url = `http://127.0.0.1:${port}/api/agent/config/user/automation-tasks`

    const payload = {
      taskFlow: [{ name: '每日战斗', type: 'fight', enabled: true }],
      legacyField: 'keep-me',
      extension: { nested: { allowed: true } }
    }
    const save = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    assert.equal(save.status, 200)
    assert.equal((await readJson(save)).success, true)

    const read = await fetch(url)
    assert.equal(read.status, 200)
    const readPayload = await readJson(read)
    assert.equal(readPayload.success, true)
    assert.deepEqual(readPayload.data, payload)
  })

  it('keeps the config type whitelist rejection for unknown types', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    await useTempConfigStorage()

    const response = await fetch(`http://127.0.0.1:${port}/api/agent/config/user/not-a-type`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })

    assert.equal(response.status, 400)
    const error = readError(await readJson(response))
    assert.equal(error.code, 'AGENT_CONFIG_TYPE_INVALID')
    assert.equal(error.retryable, false)
  })

  it('rejects non-object notification config bodies before persisting or applying', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    await useTempConfigStorage()

    const response = await fetch(`http://127.0.0.1:${port}/api/agent/notifications/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[1,2]'
    })

    assert.equal(response.status, 400)
    const payload = await readJson(response)
    assert.equal(payload.success, false)
    assert.equal(readError(payload).code, 'AGENT_CONFIG_DATA_INVALID')

    // 失败的保存不得污染内存中的通知配置
    const current = await fetch(`http://127.0.0.1:${port}/api/agent/notifications/config`)
    assert.equal(current.status, 200)
    const currentPayload = await readJson(current)
    assert.equal(currentPayload.success, true)
    assert.equal(typeof currentPayload.data, 'object')
    assert.ok(currentPayload.data !== null && !Array.isArray(currentPayload.data))
  })

  it('keeps empty-body notification saves as a legal no-op config', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    await useTempConfigStorage()

    const response = await fetch(`http://127.0.0.1:${port}/api/agent/notifications/config`, {
      method: 'POST'
    })

    assert.equal(response.status, 200)
    const payload = await readJson(response)
    assert.equal(payload.success, true)
    assert.equal(payload.message, '通知配置已保存')

    const current = await fetch(`http://127.0.0.1:${port}/api/agent/notifications/config`)
    const currentPayload = await readJson(current)
    assert.equal(typeof currentPayload.data, 'object')
  })
})

describe('operator quotes write body boundaries', () => {
  it('answers a missing body with the legacy business 400 instead of a crash', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    const origin = `http://127.0.0.1:${port}/api/operator-quotes`
    const storage = spyQuoteStorage()

    try {
      const noBody = await fetch(origin, { method: 'POST' })
      assert.equal(noBody.status, 400)
      assert.deepEqual(await noBody.json(), { error: '缺少干员名或台词' })

      // JSON 顶层原始值按公共解析错误契约返回
      const nullBody = await fetch(origin, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'null'
      })
      assert.equal(nullBody.status, 400)
      assert.equal(readError(await readJson(nullBody)).code, 'AGENT_REQUEST_BODY_INVALID')

      const updateWithoutBody = await fetch(`${origin}/operator/阿米娅`, { method: 'PUT' })
      assert.equal(updateWithoutBody.status, 400)
      assert.deepEqual(await updateWithoutBody.json(), { error: '缺少台词内容' })

      assert.equal(storage.saveCalls.length, 0)
    } finally {
      storage.restore()
    }
  })

  it('rejects wrong-typed, empty, and overlong quote fields without touching storage', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    const origin = `http://127.0.0.1:${port}/api/operator-quotes`
    const storage = spyQuoteStorage()

    try {
      const postCases: Array<[unknown, string]> = [
        [{ operator: 42, quote: '台词' }, '缺少干员名或台词'],
        [{ operator: '阿米娅', quote: '   ' }, '缺少干员名或台词'],
        [{ operator: '阿米娅', quote: 'x'.repeat(2001) }, '台词长度不能超过 2000 个字符'],
        [{ operator: 'x'.repeat(101), quote: '台词' }, '干员名长度不能超过 100 个字符']
      ]
      for (const [body, expectedError] of postCases) {
        const response = await fetch(origin, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
        assert.equal(response.status, 400)
        assert.deepEqual(await response.json(), { error: expectedError })
      }

      const putCases: Array<[unknown, string]> = [
        [{ quote: 42 }, '缺少台词内容'],
        [{ quote: '' }, '缺少台词内容'],
        [{ quote: 'x'.repeat(2001) }, '台词长度不能超过 2000 个字符']
      ]
      for (const [body, expectedError] of putCases) {
        const response = await fetch(`${origin}/operator/阿米娅`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
        assert.equal(response.status, 400)
        assert.deepEqual(await response.json(), { error: expectedError })
      }

      assert.equal(storage.saveCalls.length, 0)
    } finally {
      storage.restore()
    }
  })

  it('passes a valid trimmed quote to the storage layer and keeps the legacy response format', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    const storage = spyQuoteStorage()

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/operator-quotes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operator: ' 测试干员 ', quote: ' 台词正文 ', extraField: 'ignored' })
      })

      assert.equal(response.status, 200)
      const quotes: unknown = await response.json()
      assert.ok(Array.isArray(quotes))
      assert.deepEqual(quotes.at(-1), { operator: '测试干员', quote: '台词正文' })

      assert.equal(storage.saveCalls.length, 1)
      assert.deepEqual(storage.saveCalls[0], { operator: '测试干员', quote: '台词正文' })
    } finally {
      storage.restore()
    }
  })

  it('updates an existing quote and keeps the 404 contract for unknown operators', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    const origin = `http://127.0.0.1:${port}/api/operator-quotes/operator`
    const originalUpdateQuote = OperatorQuotes.updateQuote
    const updateCalls: Array<{ name: string; quote: string }> = []
    OperatorQuotes.updateQuote = async (name: string, quote: string): Promise<OperatorQuote | null> => {
      updateCalls.push({ name, quote })
      return name === '阿米娅'
        ? { operatorId: 'char_002_amiya', operator: '阿米娅', quote }
        : null
    }

    try {
      const updated = await fetch(`${origin}/阿米娅`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quote: ' 新台词 ' })
      })

      assert.equal(updated.status, 200)
      assert.deepEqual(await updated.json(), {
        operatorId: 'char_002_amiya',
        operator: '阿米娅',
        quote: '新台词'
      })
      assert.deepEqual(updateCalls, [{ name: '阿米娅', quote: '新台词' }])

      const missing = await fetch(`${origin}/不存在干员`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quote: '台词' })
      })
      assert.equal(missing.status, 404)
      assert.deepEqual(await missing.json(), { error: '未找到该干员的台词' })
      assert.equal(updateCalls.length, 2)
    } finally {
      OperatorQuotes.updateQuote = originalUpdateQuote
    }
  })
})
