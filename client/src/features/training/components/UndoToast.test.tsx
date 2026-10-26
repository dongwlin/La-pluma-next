// @vitest-environment jsdom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import UndoToast from './UndoToast'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const toast = () => document.querySelector<HTMLElement>('.training-undo-toast')

const renderToast = async (props: Partial<ComponentProps<typeof UndoToast>> = {}) => {
  await act(async () => root.render(
    <UndoToast
      name="阿米娅"
      pending={false}
      onUndo={vi.fn()}
      onDismiss={vi.fn()}
      {...props}
    />,
  ))
}

describe('training undo toast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('stays outside the page container and exposes a polite status', async () => {
    const onDismiss = vi.fn()
    await renderToast({ onDismiss })

    const element = toast()
    expect(element).not.toBeNull()
    expect(container.contains(element)).toBe(false)
    expect(element?.getAttribute('role')).toBe('status')
    expect(element?.getAttribute('aria-live')).toBe('polite')
    expect(element?.textContent).toContain('已移除 阿米娅')
    expect(element?.querySelector('button[aria-label="关闭移除提示"]')).not.toBeNull()

    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('pauses expiry while the pointer hovers the toast', async () => {
    const onDismiss = vi.fn()
    await renderToast({ onDismiss })

    await act(async () => {
      toast()!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('pauses expiry while keyboard focus is inside and resumes after blur', async () => {
    const onDismiss = vi.fn()
    await renderToast({ onDismiss })

    const undoButton = Array.from(toast()!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === '撤销')
    expect(undoButton).toBeDefined()

    await act(async () => undoButton!.focus())
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(onDismiss).not.toHaveBeenCalled()

    await act(async () => undoButton!.blur())
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('does not expire while an undo request is pending', async () => {
    const onDismiss = vi.fn()
    await renderToast({ onDismiss, pending: true })

    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(onDismiss).not.toHaveBeenCalled()
  })
})
