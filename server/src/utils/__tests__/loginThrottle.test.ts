import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createLoginThrottle, resolveClientRateLimitKey } from '../loginThrottle.ts'

describe('login throttle', () => {
  it('counts per key inside a fixed window and reports a retry delay', () => {
    let currentTime = 1_000
    const throttle = createLoginThrottle({
      windowMs: 1_000,
      maxAttempts: 2,
      now: () => currentTime
    })

    assert.deepEqual(throttle.tryAcquire('127.0.0.1'), { allowed: true, retryAfterSeconds: 0 })
    assert.deepEqual(throttle.tryAcquire('127.0.0.1'), { allowed: true, retryAfterSeconds: 0 })
    assert.deepEqual(throttle.tryAcquire('127.0.0.1'), { allowed: false, retryAfterSeconds: 1 })
    // 其它来源不受影响
    assert.deepEqual(throttle.tryAcquire('192.0.2.10'), { allowed: true, retryAfterSeconds: 0 })

    currentTime += 600
    assert.equal(throttle.tryAcquire('127.0.0.1').allowed, false)
    assert.equal(throttle.tryAcquire('127.0.0.1').retryAfterSeconds, 1)

    currentTime += 400
    assert.deepEqual(throttle.tryAcquire('127.0.0.1'), { allowed: true, retryAfterSeconds: 0 })
  })

  it('resets one key or the whole table', () => {
    const throttle = createLoginThrottle({ windowMs: 60_000, maxAttempts: 1 })
    throttle.tryAcquire('a')
    throttle.tryAcquire('b')
    assert.equal(throttle.tryAcquire('a').allowed, false)

    throttle.reset('a')
    assert.equal(throttle.tryAcquire('a').allowed, true)
    throttle.reset()
    assert.equal(throttle.size(), 0)
  })

  it('bounds remembered sources and drops expired windows before eviction', () => {
    let currentTime = 0
    const throttle = createLoginThrottle({
      windowMs: 100,
      maxAttempts: 5,
      maxEntries: 2,
      now: () => currentTime
    })
    throttle.tryAcquire('a')
    throttle.tryAcquire('b')
    throttle.tryAcquire('c')
    assert.ok(throttle.size() <= 2, `expected bounded entries, got ${throttle.size()}`)

    currentTime = 1_000
    throttle.tryAcquire('d')
    throttle.tryAcquire('e')
    assert.deepEqual([throttle.size(), throttle.size() <= 2], [2, true])
  })

  it('derives the key from the request address and ignores forwarded headers', () => {
    assert.equal(resolveClientRateLimitKey({ ip: '10.0.0.5' }), '10.0.0.5')
    assert.equal(resolveClientRateLimitKey({ socket: { remoteAddress: '::1' } }), '::1')
    assert.equal(resolveClientRateLimitKey({ ip: '', socket: { remoteAddress: '::1' } }), '::1')
    assert.equal(resolveClientRateLimitKey({}), 'unknown')
  })
})
