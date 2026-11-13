// @vitest-environment jsdom

import { Activity, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { usePageVisible } from './usePageVisible'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let visibility: DocumentVisibilityState
let container: HTMLDivElement
let root: Root

function Harness() {
  const visible = usePageVisible()
  return <span>{visible ? 'visible' : 'hidden'}</span>
}

describe('usePageVisible', () => {
  beforeEach(() => {
    visibility = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('reads the initial page state and follows visibility changes', async () => {
    visibility = 'hidden'
    await act(async () => root.render(<Harness />))
    expect(container.textContent).toBe('hidden')

    visibility = 'visible'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(container.textContent).toBe('visible')

    visibility = 'hidden'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(container.textContent).toBe('hidden')
  })

  it('refreshes visibility when an Activity becomes active again', async () => {
    await act(async () => root.render(<Activity mode="visible"><Harness /></Activity>))
    expect(container.textContent).toBe('visible')

    await act(async () => root.render(<Activity mode="hidden"><Harness /></Activity>))
    visibility = 'hidden'
    act(() => document.dispatchEvent(new Event('visibilitychange')))

    await act(async () => root.render(<Activity mode="visible"><Harness /></Activity>))
    expect(container.textContent).toBe('hidden')
  })
})
