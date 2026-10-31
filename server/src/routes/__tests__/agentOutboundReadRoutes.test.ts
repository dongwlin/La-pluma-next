import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import router from '../agent.ts'
import type {
  MaintenanceChangelogEntry,
  MaintenanceParadoxSearchPayload
} from '../../controllers/maintenanceDto.ts'

// 出站读取入口已随维护路由迁出聚合入口：按实际挂载关系递归解析，
// 证明入口仍通过聚合 router 暴露，而不是只存在于某个文件里。

/** Express 5 Router 的内部层结构：只声明本文件读取的字段。 */
interface MountedRouteLayer {
  route?: { path: string; methods?: Record<string, boolean>; stack: HandlerLayer[] }
  handle?: MountedRouteLayer
}

interface HandlerLayer {
  handle: RouteHandler
}

function findMountedRoute(routerInstance: unknown, method: string, path: string): MountedRouteLayer['route'] | null {
  const stack = (routerInstance as { stack?: MountedRouteLayer[] }).stack ?? []
  for (const layer of stack) {
    if (layer.route) {
      if (layer.route.path === path && layer.route.methods?.[method]) return layer.route
      continue
    }
    if (layer.handle) {
      const nested = findMountedRoute(layer.handle, method, path)
      if (nested) return nested
    }
  }
  return null
}

type RouteHandler = (req: Record<string, unknown>, res: RouteResponse, next: (error?: unknown) => void) => unknown

interface RouteResponse {
  statusCode: number
  body: unknown
  headers: Record<string, string>
  status(code: number): RouteResponse
  set(name: string, value: string): RouteResponse
  json(body: unknown): RouteResponse
}

function findHandler(method: string, path: string): RouteHandler {
  const route = findMountedRoute(router, method, path)
  assert.ok(route, `missing ${method.toUpperCase()} ${path}`)
  const layer = route.stack.at(-1)
  assert.ok(layer, `missing handler for ${method.toUpperCase()} ${path}`)
  return layer.handle
}

function createResponse(): RouteResponse {
  const res: RouteResponse = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) {
      this.statusCode = code
      return this
    },
    set(name: string, value: string) {
      this.headers[name] = value
      return this
    },
    json(body: unknown) {
      this.body = body
      return this
    }
  }
  return res
}

function createNext(): { next: (error?: unknown) => void; calls: unknown[] } {
  const calls: unknown[] = []
  return { next: error => { calls.push(error) }, calls }
}

/** 出站端口经 text() 消费响应体；真实 Response 只承载 JSON 文本，零网络访问。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Error'
  })
}

const originalFetch = globalThis.fetch
let fetchCalls: Array<{ url: string; init: RequestInit }> = []

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>

function stubFetch(handler: FetchHandler): void {
  fetchCalls = []
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const requestInit = init ?? {}
    fetchCalls.push({ url, init: requestInit })
    return handler(url, requestInit)
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(isRecord(value), `${label} 应为 JSON 对象`)
  return value
}


/** 成功信封的 data：载荷由端点 DTO 声明，信封只在此确认一次。 */
function readData<T>(body: unknown): T {
  assert.ok(isRecord(body) && body.success === true, '响应应为成功信封')
  return body.data as T
}

/** 错误信封的 error 字段：码、details 与 retryable 由调用方逐项断言。 */
function readErrorBody(body: unknown): Record<string, unknown> {
  assert.ok(isRecord(body) && body.success === false && isRecord(body.error), '响应应为错误信封')
  return body.error
}

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
    await findHandler('get', '/changelog/core')({ headers: {} }, res, createNext().next)

    assert.equal(res.statusCode, 200)
    const data = readData<MaintenanceChangelogEntry[]>(res.body)
    assert.deepEqual(data.map(item => item.version), ['v6.1.0-beta1', 'v6.0.0'])
    assert.equal(fetchCalls.length, 1)
    assert.equal(readRecord(fetchCalls[0].init.headers, 'headers').Accept, 'application/vnd.github.v3+json')
    assert.equal(readRecord(fetchCalls[0].init.headers, 'headers')['User-Agent'], 'MAA-WebUI')
  })

  it('maps upstream changelog failures to the preserved agent error envelope', async () => {
    stubFetch(() => jsonResponse({ message: 'rate limited' }, 403))
    const res = createResponse()
    await findHandler('get', '/changelog/core')({ headers: {} }, res, createNext().next)

    assert.equal(res.statusCode, 502)
    const error = readErrorBody(res.body)
    assert.equal(error.code, 'AGENT_CHANGELOG_CORE_FETCH_FAILED')
    assert.equal(error.retryable, true)
  })

  it('passes the PRTS JSON wrapper through for copilot reads', async () => {
    stubFetch(url => {
      assert.equal(url, 'https://prts.maa.plus/copilot/get/10')
      return jsonResponse({ status_code: 200, data: { id: 10, content: '{}' } })
    })
    const res = createResponse()
    await findHandler('get', '/copilots/:id')({ headers: {}, params: { id: '10' } }, res, createNext().next)

    assert.equal(res.statusCode, 200)
    const data = readData<unknown>(res.body)
    assert.deepEqual(data, { status_code: 200, data: { id: 10, content: '{}' } })
  })

  it('surfaces upstream http errors from copilot reads as structured outbound failures', async () => {
    stubFetch(() => jsonResponse({ message: 'not found' }, 404))
    const res = createResponse()
    const { next, calls } = createNext()
    await findHandler('get', '/copilots/:id')({ headers: {}, params: { id: '404' } }, res, next)

    assert.equal(res.body, null)
    assert.equal(calls.length, 1)
    const error = readRecord(calls[0], 'outbound error')
    assert.equal(error.kind, 'http-error')
    assert.equal(error.code, 'AGENT_OUTBOUND_HTTP_STATUS')
    assert.equal(error.statusCode, 404)
    assert.equal(readRecord(error.details, 'details').status, 404)
    assert.equal(error.retryable, false)
  })

  it('maps an empty upstream body to an invalid-response failure', async () => {
    stubFetch(() => new Response('', { status: 200, statusText: 'OK' }))
    const res = createResponse()
    const { next, calls } = createNext()
    await findHandler('get', '/copilots/:id')({ headers: {}, params: { id: '10' } }, res, next)

    assert.equal(calls.length, 1)
    const error = readRecord(calls[0], 'outbound error')
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
    await findHandler('get', '/paradox/search')({ headers: {}, query: { name: '干员A' } }, res, createNext().next)

    assert.equal(res.statusCode, 200)
    const data = readData<MaintenanceParadoxSearchPayload>(res.body)
    assert.equal(data.operator, '干员A')
    assert.equal(data.stageId, 'a1#f#')
    assert.equal(data.copilots[0].uri, 'prts://5')
    assert.equal(data.recommended.title, 'A-1 挂机')
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
    await findHandler('get', '/paradox/search')({ headers: {}, query: { name: '干员A' } }, res, createNext().next)

    assert.equal(res.statusCode, 404)
    const error = readErrorBody(res.body)
    assert.equal(error.code, 'AGENT_PARADOX_COPILOT_NOT_FOUND')
    assert.deepEqual(error.details, { operator: '干员A', stageId: 'a1' })
  })
})

