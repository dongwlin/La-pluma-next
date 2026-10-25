// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getItemIconCacheVersion,
  invalidateItemIconCache,
} from '../model/itemIconCache'
import { useItemIconCacheVersion } from './useItemIconCacheVersion'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function VersionProbe() {
  const version = useItemIconCacheVersion()
  return <span>{version}</span>
}

let container: HTMLDivElement
let root: Root

describe('useItemIconCacheVersion', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('re-renders consumers when the icon epoch advances', async () => {
    await act(async () => root.render(<VersionProbe />))
    const before = getItemIconCacheVersion()
    expect(container.textContent).toBe(String(before))

    await act(async () => {
      invalidateItemIconCache(before + 1_000)
    })

    expect(Number(container.textContent)).toBeGreaterThan(before)
  })
})
