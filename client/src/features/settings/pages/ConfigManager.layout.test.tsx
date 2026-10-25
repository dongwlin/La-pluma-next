// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConfigManager from './ConfigManager'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getConfigDir: vi.fn(),
  getVersion: vi.fn(),
  loadUserConfig: vi.fn(),
  openConfigDir: vi.fn(),
  saveConfig: vi.fn(),
  saveUserConfig: vi.fn(),
  setupAutoUpdate: vi.fn(),
  updateMaaCore: vi.fn(),
  updateMaaCli: vi.fn(),
  hotUpdateResources: vi.fn(),
  setMessage: vi.fn(),
}))

vi.mock('framer-motion', async () => {
  const React = await import('react')
  type MotionTestProps = Record<string, unknown> & { children?: ReactNode }
  const motionComponent = (tag: 'button' | 'div') => React.forwardRef<HTMLElement, MotionTestProps>(
    ({ children, initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }, ref) =>
      React.createElement(tag, { ...props, ref }, children as ReactNode),
  )

  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
    motion: {
      button: motionComponent('button'),
      div: motionComponent('div'),
    },
    useReducedMotion: () => true,
  }
})

vi.mock('@/shared/api', () => ({
  getErrorMessage: (result: { message?: string; error?: string }) => result.message || result.error || '未知错误',
}))

vi.mock('../api', () => ({
  discoverDevices: vi.fn(),
  getConfig: mocks.getConfig,
  getConfigDir: mocks.getConfigDir,
  getVersion: mocks.getVersion,
  hotUpdateResources: mocks.hotUpdateResources,
  openConfigDir: mocks.openConfigDir,
  saveConfig: mocks.saveConfig,
  setupAutoUpdate: mocks.setupAutoUpdate,
  testConnection: vi.fn(),
  updateMaaCli: mocks.updateMaaCli,
  updateMaaCore: mocks.updateMaaCore,
}))

vi.mock('@/features/user-config', () => ({
  loadUserConfig: mocks.loadUserConfig,
  saveUserConfig: mocks.saveUserConfig,
}))

vi.mock('@/features/runtime-status', () => ({
  useStatusStore: () => ({ setMessage: mocks.setMessage }),
  FloatingStatusIndicator: () => null,
}))

let container: HTMLDivElement
let root: Root

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('ConfigManager layout surfaces', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.getConfig.mockReset().mockResolvedValue({
      success: true,
      data: {
        adb_path: '/opt/homebrew/bin/adb',
        address: '127.0.0.1:16384',
        config: 'CompatMac',
        auto_reconnect: true,
      },
    })
    mocks.getConfigDir.mockReset().mockResolvedValue({ success: true, data: '/tmp/la-pluma' })
    mocks.getVersion.mockReset().mockResolvedValue({
      success: true,
      data: { cli: '0.7.3', core: 'v5.0.0', raw: 'v5.0.0' },
    })
    mocks.loadUserConfig.mockReset().mockResolvedValue({
      success: true,
      data: { enabled: false, time: '04:00', updateCore: true, updateCli: true },
    })
    mocks.openConfigDir.mockReset().mockResolvedValue({ success: true })
    mocks.saveConfig.mockReset().mockResolvedValue({ success: true })
    mocks.saveUserConfig.mockReset().mockResolvedValue({ success: true })
    mocks.setupAutoUpdate.mockReset().mockResolvedValue({ success: true })
    mocks.updateMaaCore.mockReset().mockResolvedValue({ success: true })
    mocks.updateMaaCli.mockReset().mockResolvedValue({ success: true })
    mocks.hotUpdateResources.mockReset().mockResolvedValue({ success: true })
    mocks.setMessage.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('keeps the config section nav roving and reports switch semantics', async () => {
    await act(async () => root.render(<ConfigManager />))
    await flush()

    const toolbar = container.querySelector('[role="toolbar"][aria-label="配置类型"]')
    expect(toolbar).not.toBeNull()
    const sections = Array.from(toolbar?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    expect(sections).toHaveLength(3)
    expect(sections.filter(button => button.getAttribute('aria-pressed') === 'true')).toHaveLength(1)
    expect(sections.find(button => button.getAttribute('aria-pressed') === 'true')?.textContent).toContain('连接')
    sections.forEach(button => {
      expect(button.tabIndex).toBe(button.getAttribute('aria-pressed') === 'true' ? 0 : -1)
    })

    const autoUpdateToggle = container.querySelector<HTMLInputElement>('input[aria-label="启用自动更新"]')
    expect(autoUpdateToggle?.getAttribute('role')).toBe('switch')
  })

  it('shows a retryable config-directory error instead of an endless loading label', async () => {
    mocks.getConfigDir.mockResolvedValueOnce({ success: false, message: '目录服务暂不可用' })

    await act(async () => root.render(<ConfigManager />))
    await flush()

    expect(container.textContent).not.toContain('正在读取目录...')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('配置目录读取失败: 目录服务暂不可用')
    const openButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('打开目录'))
    const retryButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === '重试')
    expect(openButton?.disabled).toBe(true)
    expect(retryButton).toBeDefined()

    mocks.getConfigDir.mockResolvedValueOnce({ success: true, data: '/tmp/recovered-config' })
    await act(async () => retryButton?.click())
    await flush()

    expect(container.textContent).toContain('/tmp/recovered-config')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(openButton?.disabled).toBe(false)
  })

  it('keeps auto-update edits local until the user explicitly saves them', async () => {
    mocks.loadUserConfig.mockResolvedValue({
      success: true,
      data: { enabled: true, time: '04:00', updateCore: true, updateCli: false },
    })

    await act(async () => root.render(<ConfigManager />))
    await flush()

    expect(mocks.setupAutoUpdate).not.toHaveBeenCalled()

    const timeInput = container.querySelector<HTMLInputElement>('input[placeholder="HH:MM"]')
    expect(timeInput).not.toBeNull()

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(timeInput, '05:30')
      timeInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(mocks.saveUserConfig).not.toHaveBeenCalled()
    expect(mocks.setupAutoUpdate).not.toHaveBeenCalled()
    expect(container.textContent).toContain('有尚未保存的更改')

    const saveButton = Array.from(container.querySelectorAll('button')).find(button =>
      button.textContent?.includes('保存自动更新')
    )
    expect(saveButton?.disabled).toBe(false)

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    const expectedConfig = { enabled: true, time: '05:30', updateCore: true, updateCli: false }
    expect(mocks.saveUserConfig).toHaveBeenCalledWith('auto-update', expectedConfig)
    expect(mocks.setupAutoUpdate).toHaveBeenCalledWith(expectedConfig)
    expect(mocks.saveUserConfig.mock.invocationCallOrder[0]!).toBeLessThan(mocks.setupAutoUpdate.mock.invocationCallOrder[0]!)
    expect(localStorage.getItem('autoUpdateConfig')).toBe(JSON.stringify(expectedConfig))
  })

  it('shows connection save failures in place and in the global status', async () => {
    mocks.saveConfig.mockResolvedValue({ success: false, message: '磁盘只读' })

    await act(async () => root.render(<ConfigManager />))
    await flush()

    const saveButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === '保存')
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    const inlineError = container.querySelector('[role="alert"]')
    expect(inlineError?.textContent).toContain('连接配置保存失败: 磁盘只读')
    expect(mocks.setMessage).toHaveBeenCalledWith('连接配置保存失败: 磁盘只读', 'error')
  })

  it('keeps an auto-update draft editable when persistence fails', async () => {
    mocks.loadUserConfig.mockResolvedValue({
      success: true,
      data: { enabled: true, time: '04:00', updateCore: true, updateCli: true },
    })
    mocks.saveUserConfig.mockResolvedValue({ success: false, message: '配置目录不可写' })

    await act(async () => root.render(<ConfigManager />))
    await flush()

    const timeInput = container.querySelector<HTMLInputElement>('input[placeholder="HH:MM"]')
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(timeInput, '06:15')
      timeInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const saveButton = Array.from(container.querySelectorAll('button')).find(button =>
      button.textContent?.includes('保存自动更新')
    )
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.setupAutoUpdate).not.toHaveBeenCalled()
    expect(timeInput?.value).toBe('06:15')
    expect(saveButton?.disabled).toBe(false)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('自动更新设置保存失败: 配置目录不可写')
    expect(mocks.setMessage).toHaveBeenCalledWith('自动更新设置保存失败: 配置目录不可写', 'error')
  })

  it('does not mark edits made during an auto-update save as persisted', async () => {
    const pendingSave = deferred<{ success: boolean }>()
    mocks.loadUserConfig.mockResolvedValue({
      success: true,
      data: { enabled: true, time: '04:00', updateCore: true, updateCli: true },
    })
    mocks.saveUserConfig.mockReturnValueOnce(pendingSave.promise)

    await act(async () => root.render(<ConfigManager />))
    await flush()

    const timeInput = container.querySelector<HTMLInputElement>('input[placeholder="HH:MM"]')!
    const setTime = async (value: string) => {
      await act(async () => {
        const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        valueSetter?.call(timeInput, value)
        timeInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await setTime('05:30')
    const saveButton = Array.from(container.querySelectorAll('button')).find(button =>
      button.textContent?.includes('保存自动更新')
    )!
    await act(async () => saveButton.click())
    await setTime('06:45')

    await act(async () => pendingSave.resolve({ success: true }))
    await flush()

    expect(mocks.setupAutoUpdate).toHaveBeenCalledWith({ enabled: true, time: '05:30', updateCore: true, updateCli: true })
    expect(timeInput.value).toBe('06:45')
    expect(localStorage.getItem('autoUpdateConfig')).toContain('06:45')
    expect(container.textContent).toContain('当前更改尚未保存')
    expect(saveButton.disabled).toBe(false)
  })

  it('does not let the initial connection response replace an edited draft', async () => {
    const pendingConfig = deferred<{
      success: boolean
      data: { adb_path: string; address: string; config: string; auto_reconnect: boolean }
    }>()
    mocks.getConfig.mockReturnValueOnce(pendingConfig.promise)

    await act(async () => root.render(<ConfigManager />))
    await flush()

    const addressInput = Array.from(container.querySelectorAll<HTMLInputElement>('input'))
      .find(input => input.value === '127.0.0.1:16384')!
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(addressInput, '127.0.0.1:5555')
      addressInput.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => pendingConfig.resolve({
      success: true,
      data: { adb_path: '/server/adb', address: '10.0.0.2:5555', config: 'General', auto_reconnect: false },
    }))
    await flush()

    expect(addressInput.value).toBe('127.0.0.1:5555')
  })

  it('serializes component updates behind one shared busy state', async () => {
    const pendingCoreUpdate = deferred<{ success: boolean; message: string }>()
    mocks.updateMaaCore.mockReturnValueOnce(pendingCoreUpdate.promise)
    await act(async () => root.render(<ConfigManager />))
    await flush()

    const coreButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === '更新 MaaCore')!
    const cliButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === '更新 MAA CLI')!
    await act(async () => {
      coreButton.click()
      cliButton.click()
    })

    expect(mocks.updateMaaCore).toHaveBeenCalledOnce()
    expect(mocks.updateMaaCli).not.toHaveBeenCalled()
    expect(cliButton.disabled).toBe(true)

    await act(async () => pendingCoreUpdate.resolve({ success: true, message: '已更新' }))
    await flush()
    expect(cliButton.disabled).toBe(false)
  })

  it('offers a resource retry when a core update fails at the resource step', async () => {
    mocks.updateMaaCore.mockResolvedValue({
      success: false,
      message: '资源同步失败',
      error: { details: { failedStep: 'resources', coreUpdated: true } },
    })
    await act(async () => root.render(<ConfigManager />))
    await flush()

    const coreButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === '更新 MaaCore')!
    await act(async () => coreButton.click())
    await flush()

    const retryButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === '重试资源同步')
    expect(retryButton).toBeDefined()
    expect(retryButton?.disabled).toBe(false)

    await act(async () => retryButton?.click())
    await flush()
    expect(mocks.hotUpdateResources).toHaveBeenCalledOnce()
  })

  it('does not report success when the scheduler rejects an enabled setting', async () => {
    mocks.loadUserConfig.mockResolvedValue({
      success: true,
      data: { enabled: true, time: '04:00', updateCore: true, updateCli: true },
    })
    mocks.setupAutoUpdate.mockResolvedValue({
      success: true,
      data: { success: false, message: '无法创建定时任务' },
    })

    await act(async () => root.render(<ConfigManager />))
    await flush()

    const coreCheckbox = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      .find(input => input.parentElement?.textContent?.includes('更新 MaaCore'))
    await act(async () => {
      coreCheckbox?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const saveButton = Array.from(container.querySelectorAll('button')).find(button =>
      button.textContent?.includes('保存自动更新')
    )
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('自动更新设置应用失败: 无法创建定时任务')
    expect(saveButton?.disabled).toBe(false)
    expect(mocks.setMessage).toHaveBeenCalledWith('自动更新设置应用失败: 无法创建定时任务', 'error')
  })

  it('renders unsupported resource and instance settings as honest read-only guidance', async () => {
    localStorage.setItem('laPlumaConfigSection', 'resource')

    await act(async () => root.render(<ConfigManager />))
    await flush()

    const editor = container.querySelector('.config-editor-card')
    expect(editor?.textContent).toContain('当前资源来源保持不变')
    expect(editor?.querySelector('select')).toBeNull()
    expect(Array.from(editor?.querySelectorAll('button') ?? []).some(button => button.textContent?.trim() === '保存')).toBe(false)

    const instanceButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('实例'))
    await act(async () => {
      instanceButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(editor?.textContent).toContain('触摸模式等实例选项保持当前设置')
    expect(editor?.querySelector('select')).toBeNull()
  })
})
