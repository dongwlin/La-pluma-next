// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useQueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getQueryClient } from '@/shared/query'
import { AppProviders } from './AppProviders'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function ClientProbe() {
  const client = useQueryClient()
  return <span>{client === getQueryClient() ? 'application query client' : 'unexpected query client'}</span>
}

let container: HTMLDivElement
let root: Root

describe('AppProviders query client', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    getQueryClient().clear()
  })

  it('provides the application-level query client to the app tree', async () => {
    await act(async () => {
      root.render(
        <AppProviders>
          <ClientProbe />
        </AppProviders>,
      )
    })

    expect(container.textContent).toContain('application query client')
  })
})
