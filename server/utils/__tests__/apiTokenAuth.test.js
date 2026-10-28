import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AUTH_REQUIRED_CODE,
  RATE_LIMITED_CODE,
  createOptionalApiAuth,
  matchesApiToken,
  readApiTokenCandidates
} from '../apiTokenAuth.ts'
import { createLoginThrottle } from '../loginThrottle.ts'

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

function invoke(middleware, req) {
  const recorder = createRecorder()
  let nextCalls = 0
  middleware({ headers: {}, ip: '127.0.0.1', ...req }, recorder.response, () => {
    nextCalls += 1
  })
  return { ...recorder, nextCalls }
}

describe('API token comparison', () => {
  it('accepts only identical strings and never throws on length or type differences', () => {
    assert.equal(matchesApiToken('secret-token', 'secret-token'), true)
    assert.equal(matchesApiToken('secret-tokeN', 'secret-token'), false)
    assert.equal(matchesApiToken('short', 'a-much-longer-expected-token'), false)
    assert.equal(matchesApiToken('a-much-longer-expected-token', 'short'), false)
    assert.equal(matchesApiToken('', 'secret-token'), false)
    assert.equal(matchesApiToken('secret-token', ''), false)
    assert.equal(matchesApiToken(undefined, 'secret-token'), false)
    assert.equal(matchesApiToken(['secret-token'], 'secret-token'), false)
    assert.equal(matchesApiToken({ token: 'secret-token' }, 'secret-token'), false)
    assert.equal(matchesApiToken('密码令牌', '密码令牌'), true)
    assert.equal(matchesApiToken('密码令牌', '密码令牒'), false)
    // 预期值本身非字符串时同样视为不匹配，不把类型错误抛给请求链
    assert.equal(matchesApiToken('secret-token', undefined), false)
    assert.equal(matchesApiToken('secret-token', 42), false)
  })

  it('reads bearer and header tokens without accepting malformed values', () => {
    assert.deepEqual(readApiTokenCandidates({ authorization: 'Bearer abc' }), ['abc'])
    assert.deepEqual(readApiTokenCandidates({ 'x-la-pluma-token': 'abc' }), ['abc'])
    assert.deepEqual(readApiTokenCandidates({ authorization: 'Bearer abc', 'x-la-pluma-token': 'abc' }), ['abc', 'abc'])
    assert.deepEqual(readApiTokenCandidates({ authorization: 'Bearer' }), [])
    assert.deepEqual(readApiTokenCandidates({ authorization: 'bearer abc' }), [])
    assert.deepEqual(readApiTokenCandidates({ authorization: ['Bearer abc'] }), [])
    assert.deepEqual(readApiTokenCandidates({ 'x-la-pluma-token': ['abc'] }), [])
    assert.deepEqual(readApiTokenCandidates(undefined), [])
  })
})

describe('optional API auth middleware', () => {
  const middleware = createOptionalApiAuth({ token: 'api-secret' })

  it('passes every request when no token is configured', () => {
    const disabled = createOptionalApiAuth({ token: '' })
    const result = invoke(disabled, { headers: {} })
    assert.equal(result.nextCalls, 1)
    assert.equal(result.state.statusCode, 0)
  })

  it('accepts either supported header', () => {
    assert.equal(invoke(middleware, { headers: { authorization: 'Bearer api-secret' } }).nextCalls, 1)
    assert.equal(invoke(middleware, { headers: { 'x-la-pluma-token': 'api-secret' } }).nextCalls, 1)
    assert.equal(invoke(middleware, {
      headers: { authorization: 'Bearer wrong-secret', 'x-la-pluma-token': 'api-secret' }
    }).nextCalls, 1)
  })

  it('rejects missing, malformed and differently sized tokens without leaking configuration', () => {
    for (const headers of [
      {},
      { authorization: 'Bearer wrong' },
      { authorization: 'Bearer' },
      { authorization: 'bearer api-secret' },
      { authorization: ['Bearer api-secret'] },
      { 'x-la-pluma-token': ['api-secret'] },
      { 'x-la-pluma-token': 'a-very-long-token-that-does-not-match' }
    ]) {
      const result = invoke(middleware, { headers })
      assert.equal(result.nextCalls, 0, JSON.stringify(headers))
      assert.equal(result.state.statusCode, 401)
      assert.equal(result.state.body.error.code, AUTH_REQUIRED_CODE)
      assert.deepEqual(result.state.body.error.details, {})
      assert.equal(result.headers['WWW-Authenticate'], 'Bearer realm="la-pluma"')
      const serialized = JSON.stringify(result.state.body)
      assert.ok(!serialized.includes('api-secret'))
      assert.ok(!serialized.includes('LA_PLUMA_TOKEN'))
      assert.equal(result.state.body.message, '需要有效的访问令牌')
    }
  })

  it('throttles failed attempts per source while valid tokens keep working', () => {
    const throttle = createLoginThrottle({ windowMs: 60_000, maxAttempts: 2 })
    const limited = createOptionalApiAuth({ token: 'api-secret', failureThrottle: throttle })

    assert.equal(invoke(limited, { headers: {}, ip: '203.0.113.9' }).state.statusCode, 401)
    assert.equal(invoke(limited, { headers: {}, ip: '203.0.113.9' }).state.statusCode, 401)
    const blocked = invoke(limited, { headers: {}, ip: '203.0.113.9' })
    assert.equal(blocked.nextCalls, 0)
    assert.equal(blocked.state.statusCode, 429)
    assert.equal(blocked.state.body.error.code, RATE_LIMITED_CODE)
    assert.equal(blocked.state.body.error.retryable, true)
    assert.equal(blocked.state.body.error.details.retryAfterSeconds >= 1, true)
    assert.equal(Number(blocked.headers['Retry-After']) >= 1, true)

    // 正确令牌不参与失败计数，也不会被同一来源的失败额度阻塞
    assert.equal(invoke(limited, {
      headers: { authorization: 'Bearer api-secret' }, ip: '203.0.113.9'
    }).nextCalls, 1)
    // 其它来源仍有自己的失败额度
    assert.equal(invoke(limited, { headers: {}, ip: '203.0.113.10' }).state.statusCode, 401)
  })
})
