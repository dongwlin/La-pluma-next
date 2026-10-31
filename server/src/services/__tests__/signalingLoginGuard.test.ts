import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SIGNALING_ORIGIN_FORBIDDEN_CODE,
  createSignalingLoginGuard,
  isSameOriginRequest
} from '../signalingLoginGuard.ts'
import type { SignalingLoginRequestLike, SignalingLoginResponseLike } from '../signalingLoginGuard.ts'
import { RATE_LIMITED_CODE } from '../../utils/apiTokenAuth.ts'
import { createLoginThrottle } from '../../utils/loginThrottle.ts'
import type { ApiErrorResponse } from '../../utils/apiHelper.ts'

type SignalingLoginGuard = ReturnType<typeof createSignalingLoginGuard>

interface RecorderState {
  statusCode: number
  body: unknown
}

interface Recorder {
  response: SignalingLoginResponseLike
  headers: Record<string, string>
  state: RecorderState
}

function createRecorder(): Recorder {
  const headers: Record<string, string> = {}
  const state: RecorderState = { statusCode: 0, body: null }
  const response: SignalingLoginResponseLike = {
    set(field: string, value: string) {
      headers[field] = value
      return response
    },
    status(statusCode: number) {
      state.statusCode = statusCode
      return {
        json(body: object) {
          state.body = body
          return state
        }
      }
    },
    json(body: object) {
      state.statusCode = 200
      state.body = body
      return state
    }
  }
  return { response, headers, state }
}

function invoke(guard: SignalingLoginGuard, req: SignalingLoginRequestLike): Recorder & { nextCalls: number } {
  const recorder = createRecorder()
  let nextCalls = 0
  guard({ ip: '198.51.100.7', ...req }, recorder.response, () => {
    nextCalls += 1
  })
  return { ...recorder, nextCalls }
}

/** 响应体按统一错误信封收窄；拒绝只来自守卫本身。 */
function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { success?: unknown; message?: unknown; error?: unknown }
  if (record.success !== false || typeof record.message !== 'string') return false
  const error = record.error as { code?: unknown; retryable?: unknown; details?: unknown } | null
  return typeof error === 'object'
    && error !== null
    && typeof error.code === 'string'
    && typeof error.retryable === 'boolean'
    && typeof error.details === 'object'
}

function readErrorBody(state: RecorderState): ApiErrorResponse {
  assert.ok(isApiErrorResponse(state.body), '响应体应为统一错误信封')
  return state.body
}

describe('same-origin detection', () => {
  it('accepts missing origin, matching host and local proxy port rewrites', () => {
    assert.equal(isSameOriginRequest({ headers: {} }), true)
    assert.equal(isSameOriginRequest({
      headers: { origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' }
    }), true)
    assert.equal(isSameOriginRequest({
      headers: { origin: 'https://console.example', host: 'CONSOLE.example' }
    }), true)
    assert.equal(isSameOriginRequest({
      headers: { origin: 'http://[::1]:3000', host: '[::1]:3000' }
    }), true)
    // 本地开发代理把 Host 改写成后端端口，协议也可能由反向代理终止，只比较主机名
    assert.equal(isSameOriginRequest({
      headers: { origin: 'http://localhost:5173', host: 'localhost:3000' }
    }), true)
    assert.equal(isSameOriginRequest({
      headers: { origin: 'https://console.example', host: 'console.example:3000' }
    }), true)
  })

  it('rejects cross-origin, null, malformed and host-less requests', () => {
    assert.equal(isSameOriginRequest({
      headers: { origin: 'https://evil.example', host: 'console.example' }
    }), false)
    assert.equal(isSameOriginRequest({
      headers: { origin: 'https://console.example.evil', host: 'console.example' }
    }), false)
    assert.equal(isSameOriginRequest({ headers: { origin: 'null' } }), false)
    assert.equal(isSameOriginRequest({
      headers: { origin: 'not a url', host: 'console.example' }
    }), false)
    assert.equal(isSameOriginRequest({ headers: { origin: 'https://console.example' } }), false)
    assert.equal(isSameOriginRequest({
      headers: { origin: 'http://127.0.0.1', host: 'evil.example@127.0.0.1' }
    }), false)
    assert.equal(isSameOriginRequest({
      headers: { origin: ['https://console.example'], host: 'console.example' }
    }), false)
  })
})

describe('signaling login guard', () => {
  const openGuard = (): SignalingLoginGuard => createSignalingLoginGuard({
    token: '',
    throttle: createLoginThrottle({ windowMs: 60_000, maxAttempts: 30 })
  })

  it('allows same-origin and non-browser issuance before any token is configured', () => {
    const guard = openGuard()
    assert.equal(invoke(guard, { headers: {} }).nextCalls, 1)
    assert.equal(invoke(guard, {
      headers: { origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' }
    }).nextCalls, 1)
  })

  it('rejects cross-origin issuance without a token and does not leak configuration', () => {
    const result = invoke(openGuard(), {
      headers: { origin: 'https://evil.example', host: '127.0.0.1:3000' }
    })
    assert.equal(result.nextCalls, 0)
    assert.equal(result.state.statusCode, 403)
    const body = readErrorBody(result.state)
    assert.equal(body.error.code, SIGNALING_ORIGIN_FORBIDDEN_CODE)
    assert.equal(body.error.retryable, false)
    const serialized = JSON.stringify(body)
    assert.ok(!serialized.includes('evil.example'))
    assert.ok(!serialized.includes('LA_PLUMA_TOKEN'))
  })

  it('does not impose an origin check once the token middleware owns the boundary', () => {
    const guard = createSignalingLoginGuard({
      token: 'api-secret',
      throttle: createLoginThrottle({ windowMs: 60_000, maxAttempts: 30 })
    })
    const result = invoke(guard, {
      headers: { origin: 'https://console.example', host: '127.0.0.1:3000' }
    })
    assert.equal(result.nextCalls, 1)
    assert.equal(result.state.statusCode, 0)
  })

  it('throttles ticket issuance per source and reports a retry delay', () => {
    const guard = createSignalingLoginGuard({
      token: '',
      throttle: createLoginThrottle({ windowMs: 60_000, maxAttempts: 2 })
    })
    assert.equal(invoke(guard, { headers: {}, ip: '203.0.113.5' }).nextCalls, 1)
    assert.equal(invoke(guard, { headers: {}, ip: '203.0.113.5' }).nextCalls, 1)
    const blocked = invoke(guard, { headers: {}, ip: '203.0.113.5' })
    assert.equal(blocked.nextCalls, 0)
    assert.equal(blocked.state.statusCode, 429)
    const blockedBody = readErrorBody(blocked.state)
    assert.equal(blockedBody.error.code, RATE_LIMITED_CODE)
    assert.equal(Number(blockedBody.error.details.retryAfterSeconds) >= 1, true)
    assert.equal(Number(blocked.headers['Retry-After']) >= 1, true)

    assert.equal(invoke(guard, { headers: {}, ip: '203.0.113.6' }).nextCalls, 1)
  })
})
