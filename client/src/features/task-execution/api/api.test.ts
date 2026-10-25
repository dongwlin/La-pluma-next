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

import { executeCommand, executePredefinedTask, getTaskStatus, stopTask } from './index'
import { getRun, getRunSnapshot, stopRun } from './runs'

const readHeaders = (init: RequestInit) => new Headers(init.headers)

describe('task execution command api', () => {
  beforeEach(() => {
    mocks.fetchWithAuth.mockReset().mockResolvedValue({ ok: true })
    mocks.parseJsonResponse.mockReset().mockResolvedValue({ success: true })
  })

  it('keeps the legacy positional call and sends no idempotency key', async () => {
    await executeCommand('copilot', ['prts://1'], null, null, '作业', 'combat', true)

    const [url, init] = mocks.fetchWithAuth.mock.calls[0]!
    expect(url).toBe('http://localhost:3000/api/agent/actions/run-task')
    expect(init.method).toBe('POST')
    expect(readHeaders(init).get('Idempotency-Key')).toBeNull()
    expect(JSON.parse(init.body)).toEqual({
      command: 'copilot',
      args: ['prts://1'],
      taskName: '作业',
      taskType: 'combat',
      waitForCompletion: true,
    })
  })

  it('forwards an idempotency key provided by the execution controller', async () => {
    const signal = new AbortController().signal
    await executePredefinedTask(
      'roguelike',
      'theme "萨卡兹"',
      null,
      signal,
      '肉鸽',
      'roguelike',
      true,
      { idempotencyKey: 'roguelike-20261025-01' },
    )

    const [, init] = mocks.fetchWithAuth.mock.calls[0]!
    expect(readHeaders(init).get('Idempotency-Key')).toBe('roguelike-20261025-01')
    expect(init.signal).toBe(signal)
    expect(JSON.parse(init.body)).toEqual({
      command: 'roguelike',
      args: ['theme', '萨卡兹'],
      taskName: '肉鸽',
      taskType: 'roguelike',
      waitForCompletion: true,
    })
  })

  it('keeps the legacy task status and stop endpoints for existing callers', async () => {
    await getTaskStatus()
    await stopTask()

    expect(mocks.fetchWithAuth.mock.calls[0]![0]).toBe('http://localhost:3000/api/agent/tasks/status')
    expect(mocks.fetchWithAuth.mock.calls[1]!).toEqual([
      'http://localhost:3000/api/agent/actions/stop',
      { method: 'POST' },
    ])
  })
})

describe('run observation api', () => {
  beforeEach(() => {
    mocks.fetchWithAuth.mockReset().mockResolvedValue({ ok: true })
    mocks.parseJsonResponse.mockReset().mockResolvedValue({ success: true, data: null })
  })

  it('reads the shared run snapshot with the local abort signal', async () => {
    const signal = new AbortController().signal
    await getRunSnapshot(signal)

    expect(mocks.fetchWithAuth).toHaveBeenCalledWith(
      'http://localhost:3000/api/agent/runs/current',
      { signal },
    )
  })

  it('reads one run by id', async () => {
    await getRun('run/1')

    expect(mocks.fetchWithAuth).toHaveBeenCalledWith(
      'http://localhost:3000/api/agent/runs/run%2F1',
      { signal: undefined },
    )
  })

  it('stops only the requested run', async () => {
    await stopRun('00000000-0000-4000-8000-000000000000')

    const [url, init] = mocks.fetchWithAuth.mock.calls[0]!
    expect(url).toBeInstanceOf(URL)
    expect((url as URL).pathname).toBe('/api/agent/actions/stop')
    expect((url as URL).searchParams.get('runId')).toBe('00000000-0000-4000-8000-000000000000')
    expect(init).toEqual({ method: 'POST' })
  })
})
