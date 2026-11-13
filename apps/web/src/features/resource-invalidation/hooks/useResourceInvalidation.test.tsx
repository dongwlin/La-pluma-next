// @vitest-environment jsdom

import { Activity, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ResourceInvalidationHub,
  type ResourceInvalidation,
  type ResourceScope,
} from '../model/resourceInvalidation'
import { useResourceInvalidation } from './useResourceInvalidation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DEPOT_SCOPES = ['depot', 'materials'] as const
const CATALOG_SCOPES = ['catalog'] as const

function Probe({
  hub,
  resources,
  onInvalidate,
}: {
  hub: ResourceInvalidationHub
  resources: readonly ResourceScope[]
  onInvalidate: (invalidation: ResourceInvalidation) => void
}) {
  useResourceInvalidation(resources, onInvalidate, hub)
  return <span>probe</span>
}

function ActivitySlot({
  visible,
  hub,
  resources,
  onInvalidate,
}: {
  visible: boolean
  hub: ResourceInvalidationHub
  resources: readonly ResourceScope[]
  onInvalidate: (invalidation: ResourceInvalidation) => void
}) {
  return (
    <Activity mode={visible ? 'visible' : 'hidden'}>
      <Probe hub={hub} resources={resources} onInvalidate={onInvalidate} />
    </Activity>
  )
}

let container: HTMLDivElement
let root: Root

const renderProbe = async (
  hub: ResourceInvalidationHub,
  resources: readonly ResourceScope[],
  onInvalidate: (invalidation: ResourceInvalidation) => void,
) => {
  await act(async () => {
    root.render(<Probe hub={hub} resources={resources} onInvalidate={onInvalidate} />)
  })
}

const renderActivity = async (
  visible: boolean,
  hub: ResourceInvalidationHub,
  resources: readonly ResourceScope[],
  onInvalidate: (invalidation: ResourceInvalidation) => void,
) => {
  await act(async () => {
    root.render(
      <ActivitySlot
        visible={visible}
        hub={hub}
        resources={resources}
        onInvalidate={onInvalidate}
      />,
    )
  })
}

describe('useResourceInvalidation', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('delivers a live invalidation that matches the subscribed scopes', async () => {
    const hub = new ResourceInvalidationHub()
    const onInvalidate = vi.fn()
    await renderProbe(hub, DEPOT_SCOPES, onInvalidate)

    await act(async () => {
      hub.publish({ resources: ['materials'], cause: 'recognition' })
    })

    expect(onInvalidate).toHaveBeenCalledTimes(1)
    expect(onInvalidate).toHaveBeenCalledWith({ resources: ['materials'], cause: 'recognition' })
  })

  it('ignores an invalidation for unrelated scopes', async () => {
    const hub = new ResourceInvalidationHub()
    const onInvalidate = vi.fn()
    await renderProbe(hub, DEPOT_SCOPES, onInvalidate)

    await act(async () => {
      hub.publish({ resources: ['catalog'], cause: 'resource-update' })
    })

    expect(onInvalidate).not.toHaveBeenCalled()
  })

  it('does not replay publications that happened before the first mount', async () => {
    const hub = new ResourceInvalidationHub()
    const onInvalidate = vi.fn()
    hub.publish({ resources: ['depot'], cause: 'recognition' })

    await renderProbe(hub, DEPOT_SCOPES, onInvalidate)

    expect(onInvalidate).not.toHaveBeenCalled()
  })

  it('notifies once after Activity resumes when a publication was missed while hidden', async () => {
    const hub = new ResourceInvalidationHub()
    const onInvalidate = vi.fn()
    await renderActivity(true, hub, DEPOT_SCOPES, onInvalidate)

    await renderActivity(false, hub, DEPOT_SCOPES, onInvalidate)
    await act(async () => {
      hub.publish({ resources: ['depot'], cause: 'recognition' })
    })
    expect(onInvalidate).not.toHaveBeenCalled()

    await renderActivity(true, hub, DEPOT_SCOPES, onInvalidate)

    expect(onInvalidate).toHaveBeenCalledTimes(1)
    expect(onInvalidate).toHaveBeenCalledWith({
      resources: [...DEPOT_SCOPES],
      cause: 'activity-resume',
    })
  })

  it('stops listening after unmount', async () => {
    const hub = new ResourceInvalidationHub()
    const onInvalidate = vi.fn()
    await renderProbe(hub, DEPOT_SCOPES, onInvalidate)
    await act(async () => root.unmount())
    root = createRoot(container)

    await act(async () => {
      hub.publish({ resources: ['depot'], cause: 'recognition' })
    })

    expect(onInvalidate).not.toHaveBeenCalled()
  })

  it('keeps the latest handler without resubscribing on every render', async () => {
    const hub = new ResourceInvalidationHub()
    const firstHandler = vi.fn()
    const secondHandler = vi.fn()
    await renderProbe(hub, DEPOT_SCOPES, firstHandler)
    await renderProbe(hub, DEPOT_SCOPES, secondHandler)

    await act(async () => {
      hub.publish({ resources: ['depot'], cause: 'recognition' })
    })

    expect(firstHandler).not.toHaveBeenCalled()
    expect(secondHandler).toHaveBeenCalledTimes(1)
  })

  it('reports a resume when switching to a scope that already has a newer revision', async () => {
    const hub = new ResourceInvalidationHub()
    const onInvalidate = vi.fn()
    await renderProbe(hub, CATALOG_SCOPES, onInvalidate)
    hub.publish({ resources: ['depot'], cause: 'recognition' })

    await renderProbe(hub, DEPOT_SCOPES, onInvalidate)

    expect(onInvalidate).toHaveBeenCalledWith({
      resources: [...DEPOT_SCOPES],
      cause: 'activity-resume',
    })
  })
})
