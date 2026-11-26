// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissBootShell } from './bootShell'

let reducedMotion = false

function createBootShell() {
  const shell = document.createElement('div')
  shell.className = 'la-pluma-boot'
  shell.dataset.bootShell = ''
  shell.setAttribute('role', 'status')
  shell.setAttribute('aria-busy', 'true')
  document.body.appendChild(shell)
  return shell
}

function finishTransition(shell: HTMLElement, propertyName = 'opacity') {
  const event = new Event('transitionend')
  Object.defineProperty(event, 'propertyName', { value: propertyName })
  shell.dispatchEvent(event)
}

beforeEach(() => {
  vi.useFakeTimers()
  reducedMotion = false
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reducedMotion && query === '(prefers-reduced-motion: reduce)',
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('dismissBootShell', () => {
  it('fades the shell out and removes it when the opacity transition ends', () => {
    const shell = createBootShell()

    dismissBootShell()

    expect(shell.classList.contains('is-leaving')).toBe(true)
    expect(shell.getAttribute('aria-busy')).toBe('false')

    finishTransition(shell)

    expect(shell.isConnected).toBe(false)
  })

  it('removes the shell through the fallback timer when transitionend never fires', () => {
    const shell = createBootShell()

    dismissBootShell()
    vi.advanceTimersByTime(400)

    expect(shell.isConnected).toBe(false)
  })

  it('keeps waiting when another property finishes transitioning first', () => {
    const shell = createBootShell()

    dismissBootShell()
    finishTransition(shell, 'transform')

    expect(shell.isConnected).toBe(true)

    finishTransition(shell)

    expect(shell.isConnected).toBe(false)
  })

  it('removes the shell immediately when reduced motion is preferred', () => {
    const shell = createBootShell()
    reducedMotion = true

    dismissBootShell()

    expect(shell.isConnected).toBe(false)
  })

  it('ignores repeated dismissals', () => {
    const shell = createBootShell()

    dismissBootShell()
    dismissBootShell()
    finishTransition(shell)

    expect(shell.isConnected).toBe(false)
  })

  it('does nothing when the boot shell is absent', () => {
    expect(() => dismissBootShell()).not.toThrow()
  })
})
