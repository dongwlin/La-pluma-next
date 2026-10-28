import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SIGNALING_ORIGIN_FORBIDDEN_CODE,
  createSignalingLoginGuard,
  isSameOriginRequest
} from '../signalingLoginGuard.ts'
import { RATE_LIMITED_CODE } from '../../utils/apiTokenAuth.ts'
import { createLoginThrottle } from '../../utils/loginThrottle.ts'

function createRecorder() {
  const headers = {}
  const state = { statusCode: 0, body: null }
  const response = {
    set(field, value) {
      headers[field] = value
      return response
    },
    status(statusCode) {
      state.statusCode = statusCode
      return {
        json(body) {
          state.body = body
          return state
        }
      }
    },
    json(body) {
      state.statusCode = 200
      state.body = body
      return state
    }
  }
  return { response, headers, state }
}

function invoke(guard, req) {
  const recorder = createRecorder()
  let nextCalls = 0
  guard({ ip: '198.51.100.7', ...req }, recorder.response, () => {
    nextCalls += 1
  })
  return { ...recorder, nextCalls }
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
  const openGuard = () => createSignalingLoginGuard({
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
    assert.equal(result.state.body.error.code, SIGNALING_ORIGIN_FORBIDDEN_CODE)
    assert.equal(result.state.body.error.retryable, false)
    const serialized = JSON.stringify(result.state.body)
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
    assert.equal(blocked.state.body.error.code, RATE_LIMITED_CODE)
    assert.equal(blocked.state.body.error.details.retryAfterSeconds >= 1, true)
    assert.equal(Number(blocked.headers['Retry-After']) >= 1, true)

    assert.equal(invoke(guard, { headers: {}, ip: '203.0.113.6' }).nextCalls, 1)
  })
})
