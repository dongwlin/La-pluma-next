import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  parseJsonResponse: vi.fn(),
}))

vi.mock('@/shared/api', () => ({
  API_BASE_URL: 'http://localhost:3000/api',
  fetchWithAuth: mocks.fetchWithAuth,
  parseJsonResponse: mocks.parseJsonResponse,
}))

import { executeScheduleNow } from './index'

const readHeaders = (init: RequestInit) => new Headers(init.headers)

describe('automation schedule execution api', () => {
  beforeEach(() => {
    mocks.fetchWithAuth.mockReset().mockResolvedValue({ ok: true })
    mocks.parseJsonResponse.mockReset().mockResolvedValue({ success: true })
  })

  it('keeps the legacy synchronous call unchanged', async () => {
    await executeScheduleNow('default', [{ id: 'startup-1' }])

    const [url, init] = mocks.fetchWithAuth.mock.calls[0]!
    expect(url).toBe('http://localhost:3000/api/agent/schedules/default/execute')
    expect(init.method).toBe('POST')
    expect(readHeaders(init).get('Idempotency-Key')).toBeNull()
    expect(JSON.parse(init.body)).toEqual({ taskFlow: [{ id: 'startup-1' }] })
  })

  it('requests background execution with the controller idempotency key', async () => {
    const signal = new AbortController().signal
    await executeScheduleNow('manual', [{ id: 'startup-1' }], {
      waitForCompletion: false,
      idempotencyKey: 'run_daily_flow-20261025-01',
      signal,
    })

    const [, init] = mocks.fetchWithAuth.mock.calls[0]!
    expect(readHeaders(init).get('Idempotency-Key')).toBe('run_daily_flow-20261025-01')
    expect(init.signal).toBe(signal)
    expect(JSON.parse(init.body)).toEqual({
      taskFlow: [{ id: 'startup-1' }],
      waitForCompletion: false,
    })
  })
})
