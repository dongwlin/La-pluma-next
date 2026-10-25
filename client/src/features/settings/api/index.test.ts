// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { discoverDevices, getConfig, getConfigDir, getVersion } from './index'

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

const fetchCall = (index = 0) => {
  const [input, init] = vi.mocked(globalThis.fetch).mock.calls[index]!
  return { input, init: init as RequestInit }
}

describe('settings resource reads', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('forwards the signal and validates version data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { cli: 'v0.7.0', core: 'v6.2.3', raw: 'maa-cli v0.7.0\nMaaCore v6.2.3', resource: { status: 'current' } },
    }))
    const controller = new AbortController()

    const result = await getVersion(controller.signal)

    expect(fetchCall().input).toBe('http://localhost:3000/api/agent/version')
    expect(fetchCall().init.signal).toBe(controller.signal)
    expect(result.success).toBe(true)
    expect(result.data?.cli).toBe('v0.7.0')
  })

  it('turns a malformed version payload into a domain failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { cli: 7, core: null, raw: '' },
    }))

    const result = await getVersion()

    expect(result.success).toBe(false)
    expect(result.errorInfo).toMatchObject({
      code: 'INVALID_DOMAIN_PAYLOAD',
      message: '版本信息格式不正确',
    })
  })

  it('keeps the legacy string config directory and the object form', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ success: true, data: '/tmp/la-pluma' }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { path: '/tmp/la-pluma' } }))
    const controller = new AbortController()

    const legacy = await getConfigDir(controller.signal)
    const current = await getConfigDir()

    expect(fetchCall(0).init.signal).toBe(controller.signal)
    expect(legacy.success).toBe(true)
    expect(legacy.data).toBe('/tmp/la-pluma')
    expect(current.success).toBe(true)
    expect(current.data).toEqual({ path: '/tmp/la-pluma' })
  })

  it('rejects an empty config directory payload instead of accepting an empty string', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: true, data: '' }))

    const result = await getConfigDir()

    expect(result.success).toBe(false)
    expect(result.errorInfo?.code).toBe('INVALID_DOMAIN_PAYLOAD')
  })

  it('forwards the profile read signal and accepts a connection object', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { adb_path: '/usr/bin/adb', address: '127.0.0.1:5555', config: 'CompatMac', touch_mode: 'minitouch' },
    }))
    const controller = new AbortController()

    const result = await getConfig('default', controller.signal)

    expect(fetchCall().input).toBe('http://localhost:3000/api/agent/config/maa/default')
    expect(fetchCall().init.signal).toBe(controller.signal)
    expect(result.success).toBe(true)
    expect(result.data?.address).toBe('127.0.0.1:5555')
    expect(result.data?.touch_mode).toBe('minitouch')
  })

  it('accepts a partial connection profile because MAA fields are optional', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { address: '127.0.0.1:5555' },
    }))

    const result = await getConfig()

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ address: '127.0.0.1:5555' })
  })

  it('rejects a connection payload with an invalid known field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { adb_path: '/usr/bin/adb', address: 127, config: 'CompatMac' },
    }))

    const result = await getConfig()

    expect(result.success).toBe(false)
    expect(result.errorInfo).toMatchObject({
      code: 'INVALID_DOMAIN_PAYLOAD',
      message: '连接配置格式不正确',
    })
  })

  it('forwards the signal for device discovery and accepts its nested success payload', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      success: true,
      data: { success: false, adbAvailable: false, devices: [], candidates: [], message: 'ADB 不可用' },
    }))
    const controller = new AbortController()

    const result = await discoverDevices('/usr/bin/adb', controller.signal)

    expect(fetchCall().input).toBe('http://localhost:3000/api/agent/actions/discover-devices?adbPath=%2Fusr%2Fbin%2Fadb')
    expect(fetchCall().init.signal).toBe(controller.signal)
    expect(result.success).toBe(true)
    expect(result.data?.message).toBe('ADB 不可用')
  })
})
