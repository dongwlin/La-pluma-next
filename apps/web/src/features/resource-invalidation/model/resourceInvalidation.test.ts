import { describe, expect, it, vi } from 'vitest'
import {
  RESOURCE_INVALIDATION_CAUSES,
  RESOURCE_SCOPES,
  ResourceInvalidationHub,
} from './resourceInvalidation'

describe('resource invalidation hub', () => {
  it('publishes deduplicated scopes with the original cause and detail', () => {
    const hub = new ResourceInvalidationHub()
    const listener = vi.fn()
    hub.subscribe(listener)

    hub.publish({
      resources: ['depot', 'materials', 'depot'],
      cause: 'recognition',
      detail: { stageCount: 2 },
    })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({
      resources: ['depot', 'materials'],
      cause: 'recognition',
      detail: { stageCount: 2 },
    })
  })

  it('ignores publications without resources', () => {
    const hub = new ResourceInvalidationHub()
    const listener = vi.fn()
    hub.subscribe(listener)

    hub.publish({ resources: [], cause: 'resource-update' })

    expect(listener).not.toHaveBeenCalled()
    expect(hub.getRevision(['depot'])).toBe(0)
  })

  it('tracks the latest revision per scope and matches scopes independently', () => {
    const hub = new ResourceInvalidationHub()

    hub.publish({ resources: ['depot'], cause: 'recognition' })
    const depotRevision = hub.getRevision(['depot'])
    hub.publish({ resources: ['catalog'], cause: 'resource-update' })

    expect(depotRevision).toBeGreaterThan(0)
    expect(hub.getRevision(['depot'])).toBe(depotRevision)
    expect(hub.getRevision(['catalog'])).toBeGreaterThan(depotRevision)
    expect(hub.getRevision(['depot', 'catalog'])).toBe(hub.getRevision(['catalog']))
    expect(hub.getRevision(['training-queue'])).toBe(0)
    expect(hub.getRevision([])).toBe(0)
  })

  it('stops notifying an unsubscribed listener', () => {
    const hub = new ResourceInvalidationHub()
    const listener = vi.fn()
    const unsubscribe = hub.subscribe(listener)

    unsubscribe()
    hub.publish({ resources: ['depot'], cause: 'recognition' })

    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps delivering when one listener throws', () => {
    const hub = new ResourceInvalidationHub()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const healthy = vi.fn()
    hub.subscribe(() => {
      throw new Error('broken listener')
    })
    hub.subscribe(healthy)

    hub.publish({ resources: ['depot'], cause: 'recognition' })

    expect(healthy).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('keeps the exported scope and cause vocabularies unique', () => {
    expect(new Set(RESOURCE_SCOPES).size).toBe(RESOURCE_SCOPES.length)
    expect(new Set(RESOURCE_INVALIDATION_CAUSES).size).toBe(RESOURCE_INVALIDATION_CAUSES.length)
  })
})
