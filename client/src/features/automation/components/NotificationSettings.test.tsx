// @vitest-environment jsdom

import { Activity, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/shared/query'
import NotificationSettings from './NotificationSettings'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  getNotificationConfig: vi.fn(),
  saveNotificationConfig: vi.fn(),
  testNotificationChannel: vi.fn(),
}))

vi.mock('../api', () => ({
  getActivity: vi.fn(),
  getScheduleExecutionStatus: vi.fn(),
  getNotificationConfig: mocks.getNotificationConfig,
  saveNotificationConfig: mocks.saveNotificationConfig,
  testNotificationChannel: mocks.testNotificationChannel,
}))

interface NotificationConfigFixture {
  enabled: boolean
  channels: {
    telegram: {
      enabled: boolean
      botToken: string
      chatId: string
    }
  }
}

const loadedConfig: NotificationConfigFixture = {
  enabled: true,
  channels: {
    telegram: {
      enabled: true,
      botToken: 'server-token',
      chatId: 'server-chat',
    },
  },
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

let container: HTMLDivElement
let root: Root
let queryClient: ReturnType<typeof createQueryClient>

const flush = async () => {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

const renderMode = async (mode: 'visible' | 'hidden') => {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Activity mode={mode}>
          <NotificationSettings />
        </Activity>
      </QueryClientProvider>,
    )
  })
  await flush()
}

const setInputValue = async (input: HTMLInputElement, value: string) => {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    valueSetter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

const buttonByText = (text: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
  .find(button => button.textContent?.trim() === text)

describe('NotificationSettings Query lifecycle', () => {
  beforeEach(() => {
    mocks.getNotificationConfig.mockReset().mockResolvedValue({ success: true, data: loadedConfig })
    mocks.saveNotificationConfig.mockReset().mockResolvedValue({ success: true, message: '通知配置已保存' })
    mocks.testNotificationChannel.mockReset().mockResolvedValue({ success: true, message: '测试通知已发送' })
    queryClient = createQueryClient()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    queryClient.clear()
    vi.restoreAllMocks()
  })

  it('loads once and reuses the cached config when Activity hides and restores', async () => {
    await renderMode('visible')
    expect(mocks.getNotificationConfig).toHaveBeenCalledOnce()

    await renderMode('hidden')
    await renderMode('visible')
    expect(mocks.getNotificationConfig).toHaveBeenCalledOnce()

    expect(container.querySelector<HTMLInputElement>('input[placeholder="Telegram Bot Token"]')?.value).toBe('server-token')
  })

  it('does not replace an unsaved draft when Activity restores the loading effect', async () => {
    await renderMode('visible')
    const tokenInput = container.querySelector<HTMLInputElement>('input[placeholder="Telegram Bot Token"]')
    expect(tokenInput?.value).toBe('server-token')

    await setInputValue(tokenInput!, 'draft-token')
    expect(tokenInput?.value).toBe('draft-token')

    await renderMode('hidden')
    await renderMode('visible')

    expect(mocks.getNotificationConfig).toHaveBeenCalledOnce()
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Telegram Bot Token"]')?.value).toBe('draft-token')
  })

  it('shows a retryable load error and blocks saving an empty fallback config', async () => {
    mocks.getNotificationConfig
      .mockResolvedValueOnce({ success: false, message: '通知配置暂不可用' })
      .mockResolvedValueOnce({ success: true, data: loadedConfig })

    await renderMode('visible')

    const alert = container.querySelector<HTMLElement>('[role="alert"]')
    expect(alert?.textContent).toContain('通知配置暂不可用')
    expect(buttonByText('保存')?.disabled).toBe(true)
    const retryButton = buttonByText('重新加载')
    expect(retryButton).toBeDefined()

    await act(async () => retryButton?.click())
    await flush()

    expect(mocks.getNotificationConfig).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Telegram Bot Token"]')?.value).toBe('server-token')
    expect(buttonByText('保存')?.disabled).toBe(false)
  })

  it('finishes a pending save after Activity cleanup and writes the Query cache', async () => {
    const saveRequest = deferred<{ success: boolean; message: string }>()
    mocks.saveNotificationConfig.mockReturnValue(saveRequest.promise)

    await renderMode('visible')
    await act(async () => buttonByText('保存')?.click())
    expect(mocks.saveNotificationConfig).toHaveBeenCalledOnce()
    expect(mocks.saveNotificationConfig.mock.calls[0]?.[1]).toBeUndefined()

    await renderMode('hidden')
    await act(async () => saveRequest.resolve({ success: true, message: '已保存' }))
    await flush()

    expect(queryClient.getQueryData(['automation', 'notification-config'])).toEqual(loadedConfig)
  })

  it('reuses cached notification config after a real remount', async () => {
    await renderMode('visible')
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Telegram Bot Token"]')?.value).toBe('server-token')

    await act(async () => root.unmount())
    root = createRoot(container)
    await renderMode('visible')

    expect(mocks.getNotificationConfig).toHaveBeenCalledOnce()
  })

  it('aborts a pending notification test when the component effects are removed', async () => {
    const testRequest = deferred<{ success: boolean; message: string }>()
    mocks.testNotificationChannel.mockReturnValue(testRequest.promise)

    await renderMode('visible')
    await act(async () => buttonByText('测试')?.click())
    const testCall = mocks.testNotificationChannel.mock.calls[0]
    const testSignal = testCall?.[2] as AbortSignal | undefined
    expect(testSignal?.aborted).toBe(false)

    await act(async () => root.unmount())
    expect(testSignal?.aborted).toBe(true)

    await act(async () => testRequest.resolve({ success: true, message: '已发送' }))
    await flush()
  })
})
