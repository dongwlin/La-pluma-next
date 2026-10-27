import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import router from '../agent.js'
import { createOutboundHttpClient } from '../../services/outboundRequestService.ts'

function findHandler(method, path) {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods?.[method])
  assert.ok(layer, `missing ${method.toUpperCase()} ${path}`)
  return layer.route.stack.at(-1).handle
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code
      return this
    },
    set(name, value) {
      this.headers[name] = value
      return this
    },
    json(body) {
      this.body = body
      return this
    }
  }
}

function createNext() {
  const calls = []
  const next = error => {
    calls.push(error)
  }
  next.calls = calls
  return next
}

/** 出站端口经 text() 消费响应体；stub 返回 JSON 文本，零网络访问。 */
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body)
  }
}

const originalFetch = globalThis.fetch
let fetchCalls

function stubFetch(handler) {
  fetchCalls = []
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init })
    return handler(String(url), init)
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Agent outbound read routes', () => {
  it('serves core changelog releases through the outbound port with preserved headers', async () => {
    stubFetch(url => {
      assert.equal(url, 'https://api.github.com/repos/MaaAssistantArknights/MaaAssistantArknights/releases?per_page=100')
      return jsonResponse([
        { tag_name: 'v6.1.0-beta1', name: 'beta', body: 'b', published_at: 't1', html_url: 'u1', prerelease: true },
        { tag_name: 'v6.0.0', name: 'stable', body: 's', published_at: 't2', html_url: 'u2', prerelease: false }
      ])
    })
    const res = createResponse()
    await findHandler('get', '/changelog/core')({ headers: {} }, res, createNext())

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.success, true)
    assert.deepEqual(res.body.data.map(item => item.version), ['v6.1.0-beta1', 'v6.0.0'])
    assert.equal(fetchCalls.length, 1)
    assert.equal(fetchCalls[0].init.headers.Accept, 'application/vnd.github.v3+json')
    assert.equal(fetchCalls[0].init.headers['User-Agent'], 'MAA-WebUI')
  })

  it('maps upstream changelog failures to the preserved agent error envelope', async () => {
    stubFetch(() => jsonResponse({ message: 'rate limited' }, 403))
    const res = createResponse()
    await findHandler('get', '/changelog/core')({ headers: {} }, res, createNext())

    assert.equal(res.statusCode, 502)
    assert.equal(res.body.success, false)
    assert.equal(res.body.error.code, 'AGENT_CHANGELOG_CORE_FETCH_FAILED')
    assert.equal(res.body.error.retryable, true)
  })

  it('passes the PRTS JSON wrapper through for copilot reads', async () => {
    stubFetch(url => {
      assert.equal(url, 'https://prts.maa.plus/copilot/get/10')
      return jsonResponse({ status_code: 200, data: { id: 10, content: '{}' } })
    })
    const res = createResponse()
    await findHandler('get', '/copilots/:id')({ headers: {}, params: { id: '10' } }, res, createNext())

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body.data, { status_code: 200, data: { id: 10, content: '{}' } })
  })

  it('surfaces upstream http errors from copilot reads as structured outbound failures', async () => {
    stubFetch(() => jsonResponse({ message: 'not found' }, 404))
    const res = createResponse()
    const next = createNext()
    await findHandler('get', '/copilots/:id')({ headers: {}, params: { id: '404' } }, res, next)

    assert.equal(res.body, null)
    assert.equal(next.calls.length, 1)
    const error = next.calls[0]
    assert.equal(error.kind, 'http-error')
    assert.equal(error.code, 'AGENT_OUTBOUND_HTTP_STATUS')
    assert.equal(error.statusCode, 404)
    assert.equal(error.details.status, 404)
    assert.equal(error.retryable, false)
  })

  it('maps an empty upstream body to an invalid-response failure', async () => {
    stubFetch(() => ({ ok: true, status: 200, statusText: 'OK', text: async () => '' }))
    const res = createResponse()
    const next = createNext()
    await findHandler('get', '/copilots/:id')({ headers: {}, params: { id: '10' } }, res, next)

    assert.equal(next.calls.length, 1)
    const error = next.calls[0]
    assert.equal(error.kind, 'invalid-response')
    assert.equal(error.code, 'AGENT_OUTBOUND_RESPONSE_INVALID')
    assert.equal(error.statusCode, 502)
  })

  it('resolves paradox operators from the network fallback and keeps the stage query contract', async () => {
    stubFetch(url => {
      if (url.includes('handbook_info_table.json')) {
        return jsonResponse({ handbookStageData: { charA: { stageId: 'a1#f#', code: 'A-1', name: 'Stage A' } } })
      }
      if (url.includes('character_table.json')) {
        return jsonResponse({ charA: { name: '干员A' } })
      }
      assert.match(url, /level_keyword=a1/)
      return jsonResponse({
        status_code: 200,
        data: { data: [{ id: 5, content: JSON.stringify({ doc: { title: 'A-1 挂机' } }), views: 3, hot_score: 9, uploader_id: 'u1' }] }
      })
    })
    const res = createResponse()
    await findHandler('get', '/paradox/search')({ headers: {}, query: { name: '干员A' } }, res, createNext())

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.operator, '干员A')
    assert.equal(res.body.data.stageId, 'a1#f#')
    assert.equal(res.body.data.copilots[0].uri, 'prts://5')
    assert.equal(res.body.data.recommended.title, 'A-1 挂机')
    assert.equal(fetchCalls.length, 3)
  })

  it('keeps the paradox not-found contract when the stage query returns no copilots', async () => {
    stubFetch(url => {
      if (url.includes('handbook_info_table.json')) {
        return jsonResponse({ handbookStageData: { charA: { stageId: 'a1', code: 'A-1', name: 'Stage A' } } })
      }
      if (url.includes('character_table.json')) {
        return jsonResponse({ charA: { name: '干员A' } })
      }
      return jsonResponse({ status_code: 200, data: { data: [] } })
    })
    const res = createResponse()
    await findHandler('get', '/paradox/search')({ headers: {}, query: { name: '干员A' } }, res, createNext())

    assert.equal(res.statusCode, 404)
    assert.equal(res.body.error.code, 'AGENT_PARADOX_COPILOT_NOT_FOUND')
    assert.deepEqual(res.body.error.details, { operator: '干员A', stageId: 'a1' })
  })
})

describe('Outbound client cancellation and timeout composition', () => {
  // 迁移后的调用方共用 createOutboundHttpClient 组合；时限/取消在组合层以短时限 fixture 验证，
  // 避免在路由测试中等待缺省 15 秒时限。
  it('aborts an in-flight read when the caller signal fires', async () => {
    const client = createOutboundHttpClient({ defaultTimeoutMs: 5000 })
    stubFetch((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason))
    }))
    const controller = new AbortController()
    const pending = client.requestJson('https://upstream.invalid/data', { signal: controller.signal })
    setTimeout(() => controller.abort(), 5)

    await assert.rejects(pending, error => {
      assert.equal(error.kind, 'cancelled')
      assert.equal(error.code, 'AGENT_OUTBOUND_CANCELLED')
      assert.equal(error.statusCode, 499)
      return true
    })
  })

  it('reports a domain timeout when the upstream never answers within the limit', async () => {
    const client = createOutboundHttpClient({ defaultTimeoutMs: 20 })
    stubFetch((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))

    // 退避归零仅压缩测试等待；GET 超时仍按缺省重试后抛出最终失败。
    await assert.rejects(client.requestJson('https://upstream.invalid/slow', { retry: { baseDelayMs: 0 } }), error => {
      assert.equal(error.kind, 'timeout')
      assert.equal(error.code, 'AGENT_OUTBOUND_TIMEOUT')
      assert.equal(error.statusCode, 504)
      assert.equal(error.retryable, true)
      return true
    })
  })
})
