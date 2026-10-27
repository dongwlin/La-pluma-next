import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createLaPlumaApp } from '../server.js'
import { setConfigStorageDirForTests } from '../services/configStorageService.ts'
import OperatorQuotes from '../services/operatorQuotesService.js'

const servers = []
const tempDirs = []

async function listen(app) {
  const server = createServer(app)
  servers.push(server)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function makeTempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function useTempConfigStorage() {
  const dir = await makeTempDir('la-pluma-config-http-')
  setConfigStorageDirForTests(dir)
  return dir
}

/**
 * 存储间谍：记录传入存储层的写入载荷；测试结束后恢复原实现。
 */
function spyQuoteStorage() {
  const originalSaveQuotes = OperatorQuotes.saveQuotes
  const saveCalls = []
  OperatorQuotes.saveQuotes = quotes => {
    saveCalls.push(quotes)
    return true
  }
  return {
    saveCalls,
    restore() {
      OperatorQuotes.saveQuotes = originalSaveQuotes
    }
  }
}

afterEach(async () => {
  setConfigStorageDirForTests(null)
  while (servers.length) {
    const server = servers.pop()
    server.closeIdleConnections?.()
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
  while (tempDirs.length) await rm(tempDirs.pop(), { recursive: true, force: true })
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
      const payload = await response.json()
      assert.equal(payload.success, false)
      assert.equal(payload.error.code, 'AGENT_REQUEST_BODY_INVALID')
    }

    // JSON 数组能被解析器接受，但会在写入前被顶层校验拒绝
    const arrayResponse = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[1,2,3]'
    })
    assert.equal(arrayResponse.status, 400)
    const arrayPayload = await arrayResponse.json()
    assert.equal(arrayPayload.success, false)
    assert.equal(arrayPayload.error.code, 'AGENT_CONFIG_DATA_INVALID')
    assert.equal(arrayPayload.error.retryable, false)
    assert.deepEqual(await readdir(storageDir), [])

    // 全局 JSON 解析器把缺失 body 归一为空对象：按既有行为视为合法的空配置
    const noBody = await fetch(url, { method: 'POST' })
    assert.equal(noBody.status, 200)
    assert.equal((await noBody.json()).success, true)
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
    const savePayload = await save.json()
    assert.equal(savePayload.success, true)

    const read = await fetch(url)
    assert.equal(read.status, 200)
    const readPayload = await read.json()
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
    const payload = await response.json()
    assert.equal(payload.error.code, 'AGENT_CONFIG_TYPE_INVALID')
    assert.equal(payload.error.retryable, false)
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
    const payload = await response.json()
    assert.equal(payload.success, false)
    assert.equal(payload.error.code, 'AGENT_CONFIG_DATA_INVALID')

    // 失败的保存不得污染内存中的通知配置
    const current = await fetch(`http://127.0.0.1:${port}/api/agent/notifications/config`)
    assert.equal(current.status, 200)
    const currentPayload = await current.json()
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
    const payload = await response.json()
    assert.equal(payload.success, true)
    assert.equal(payload.message, '通知配置已保存')

    const current = await fetch(`http://127.0.0.1:${port}/api/agent/notifications/config`)
    const currentPayload = await current.json()
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
      assert.equal((await nullBody.json()).error.code, 'AGENT_REQUEST_BODY_INVALID')

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
      const postCases = [
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

      const putCases = [
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

  it('stores a valid quote through the storage layer and keeps the legacy response format', async () => {
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
      const quotes = await response.json()
      assert.ok(Array.isArray(quotes))
      assert.deepEqual(quotes.at(-1), { operator: '测试干员', quote: '台词正文' })

      assert.equal(storage.saveCalls.length, 1)
      assert.deepEqual(storage.saveCalls[0].at(-1), { operator: '测试干员', quote: '台词正文' })
    } finally {
      storage.restore()
    }
  })

  it('updates an existing quote and keeps the 404 contract for unknown operators', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    const origin = `http://127.0.0.1:${port}/api/operator-quotes/operator`
    const storage = spyQuoteStorage()
    const originalLoadQuotes = OperatorQuotes.loadQuotes
    OperatorQuotes.loadQuotes = () => [
      { operatorId: 'char_002_amiya', operator: '阿米娅', quote: '旧台词' }
    ]

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
      assert.equal(storage.saveCalls.length, 1)
      assert.deepEqual(storage.saveCalls[0], [
        { operatorId: 'char_002_amiya', operator: '阿米娅', quote: '新台词' }
      ])

      const missing = await fetch(`${origin}/不存在干员`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quote: '台词' })
      })
      assert.equal(missing.status, 404)
      assert.deepEqual(await missing.json(), { error: '未找到该干员的台词' })
      assert.equal(storage.saveCalls.length, 1)
    } finally {
      OperatorQuotes.loadQuotes = originalLoadQuotes
      storage.restore()
    }
  })
})
