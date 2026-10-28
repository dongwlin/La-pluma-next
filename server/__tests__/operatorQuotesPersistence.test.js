import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

// 服务在导入时绑定台词存储路径：先注入覆盖变量再动态导入应用组装入口，
// 全部断言走真实 HTTP；测试运行器逐文件、逐进程执行，不影响其他用例。
const tempDir = await mkdtemp(join(tmpdir(), 'la-pluma-quotes-persistence-'))
const quotesPath = join(tempDir, 'operatorQuotes.json')
process.env.LA_PLUMA_OPERATOR_QUOTES_STORE = quotesPath

const { createLaPlumaApp } = await import('../server.js')

let server
let origin

before(async () => {
  const app = createLaPlumaApp({ env: {} })
  server = createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${server.address().port}/api/operator-quotes`
})

after(async () => {
  server.closeIdleConnections?.()
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
  await chmod(tempDir, 0o755).catch(() => undefined)
  await rm(tempDir, { recursive: true, force: true })
})

describe('operator quotes HTTP persistence', () => {
  it('serves built-in quotes over the legacy read endpoints when no file exists', async () => {
    const all = await fetch(`${origin}/all`)
    assert.equal(all.status, 200)
    const quotes = await all.json()
    assert.ok(Array.isArray(quotes))
    assert.ok(quotes.length > 0)
    assert.deepEqual(quotes[0], { operatorId: 'char_002_amiya', operator: '阿米娅', quote: '今天也请多指教' })

    for (const path of ['/daily', '/random']) {
      const response = await fetch(`${origin}${path}`)
      assert.equal(response.status, 200)
      const quote = await response.json()
      assert.ok(quote.operator)
      assert.ok(quote.quote)
      assert.ok(typeof quote.operatorId === 'string')
    }

    const amiya = await fetch(`${origin}/operator/阿米娅`)
    assert.equal(amiya.status, 200)
    assert.equal((await amiya.json()).operatorId, 'char_002_amiya')

    const missing = await fetch(`${origin}/operator/不存在干员`)
    assert.equal(missing.status, 404)
    assert.deepEqual(await missing.json(), { error: '未找到该干员的台词' })
  })

  it('keeps the legacy response shapes for add, update and delete', async () => {
    const added = await fetch(origin, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operator: '测试干员', quote: '台词正文' })
    })
    assert.equal(added.status, 200)
    const quotes = await added.json()
    assert.ok(Array.isArray(quotes))
    assert.deepEqual(quotes.at(-1), { operator: '测试干员', quote: '台词正文' })

    const updated = await fetch(`${origin}/operator/测试干员`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quote: '更新后的台词' })
    })
    assert.equal(updated.status, 200)
    // 更新响应经存储层归一读取：未知干员的 operatorId 归一为空串（与旧实现一致）
    assert.deepEqual(await updated.json(), { operatorId: '', operator: '测试干员', quote: '更新后的台词' })

    const stillMissing = await fetch(`${origin}/operator/不存在干员`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quote: '台词' })
    })
    assert.equal(stillMissing.status, 404)
    assert.deepEqual(await stillMissing.json(), { error: '未找到该干员的台词' })

    const removed = await fetch(`${origin}/operator/测试干员`, { method: 'DELETE' })
    assert.equal(removed.status, 200)
    const remaining = await removed.json()
    assert.ok(Array.isArray(remaining))
    assert.equal(remaining.some(quote => quote.operator === '测试干员'), false)
  })

  it('keeps concurrent writes from losing updates', async () => {
    await writeFile(quotesPath, JSON.stringify([
      { operatorId: 'char_002_amiya', operator: '阿米娅', quote: '旧台词' }
    ]), 'utf-8')

    const responses = await Promise.all([
      fetch(origin, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operator: '干员一', quote: '台词一' })
      }),
      fetch(origin, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operator: '干员二', quote: '台词二' })
      }),
      fetch(`${origin}/operator/阿米娅`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quote: '新台词' })
      })
    ])
    for (const response of responses) {
      assert.equal(response.status, 200)
    }

    const stored = JSON.parse(await readFile(quotesPath, 'utf-8'))
    assert.equal(stored.length, 3)
    assert.ok(stored.some(quote => quote.operator === '干员一'))
    assert.ok(stored.some(quote => quote.operator === '干员二'))
    assert.equal(stored.find(quote => quote.operator === '阿米娅').quote, '新台词')
  })

  it('answers a corrupted quotes file with the structured data error and never overwrites it', async () => {
    await writeFile(quotesPath, 'not-json', 'utf-8')

    const read = await fetch(`${origin}/all`)
    assert.equal(read.status, 500)
    const readPayload = await read.json()
    assert.equal(readPayload.success, false)
    assert.equal(readPayload.error.code, 'AGENT_QUOTES_DATA_INVALID')
    assert.equal(readPayload.error.retryable, false)
    assert.match(readPayload.message, /读取 JSON 文件失败/)

    const write = await fetch(origin, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operator: '干员', quote: '台词' })
    })
    assert.equal(write.status, 500)
    assert.equal((await write.json()).error.code, 'AGENT_QUOTES_DATA_INVALID')

    // 损坏内容原样保留，不被兜底文案覆盖
    assert.equal(await readFile(quotesPath, 'utf-8'), 'not-json')
  })

  it('treats a non-array quotes file as corrupted without overwriting it', async () => {
    await writeFile(quotesPath, '{"operator":"阿米娅"}', 'utf-8')

    const read = await fetch(`${origin}/all`)
    assert.equal(read.status, 500)
    const payload = await read.json()
    assert.equal(payload.error.code, 'AGENT_QUOTES_DATA_INVALID')
    assert.match(payload.message, /台词数据文件顶层不是数组/)

    assert.equal(await readFile(quotesPath, 'utf-8'), '{"operator":"阿米娅"}')
  })

  it('answers a write failure with a retryable save error and keeps the stored file', async () => {
    const original = JSON.stringify([
      { operatorId: 'char_002_amiya', operator: '阿米娅', quote: '旧台词' }
    ], null, 2)
    await writeFile(quotesPath, original, 'utf-8')
    await chmod(tempDir, 0o555)

    try {
      const response = await fetch(origin, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operator: '干员', quote: '台词' })
      })
      assert.equal(response.status, 500)
      const payload = await response.json()
      assert.equal(payload.success, false)
      assert.equal(payload.error.code, 'AGENT_QUOTES_SAVE_FAILED')
      assert.equal(payload.error.retryable, true)
    } finally {
      await chmod(tempDir, 0o755)
    }

    assert.equal(await readFile(quotesPath, 'utf-8'), original)
  })
})
