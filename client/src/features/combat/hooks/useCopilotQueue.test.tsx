// @vitest-environment jsdom

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CopilotQueueEntry } from '../model/copilotQueue'
import {
  COPILOT_QUEUE_STORAGE_KEY,
  parseCopilotQueue,
  serializeCopilotQueue,
} from '../model/copilotQueueStorage'
import { useCopilotQueue, type UseCopilotQueueResult } from './useCopilotQueue'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const entry = (id: string, uri: string): CopilotQueueEntry => ({
  id,
  source: 'link',
  uri,
  title: `作业 ${id}`,
  addedAt: 1,
})

const setEntry = (id: string, index: number): CopilotQueueEntry => ({
  id,
  source: 'set',
  uri: `prts://${100 + index}`,
  title: `关卡 ${index}`,
  setId: '48990',
  setItemIndex: index,
  addedAt: 1,
})

const readStored = () => parseCopilotQueue(localStorage.getItem(COPILOT_QUEUE_STORAGE_KEY))

let root: Root
let container: HTMLDivElement
let latest: UseCopilotQueueResult | null = null

function Harness() {
  const queue = useCopilotQueue()
  useEffect(() => {
    latest = queue
  })
  return null
}

const renderQueue = async () => {
  await act(async () => {
    root.render(<Harness />)
  })
}

const run = async (action: () => void) => {
  await act(async () => {
    action()
  })
}

beforeEach(() => {
  localStorage.clear()
  latest = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('useCopilotQueue', () => {
  it('hydrates stored entries and selects them all by default', async () => {
    localStorage.setItem(COPILOT_QUEUE_STORAGE_KEY, serializeCopilotQueue([
      entry('a', 'prts://1'),
      entry('b', 'prts://2'),
    ]))

    await renderQueue()

    expect(latest?.entries.map(item => item.uri)).toEqual(['prts://1', 'prts://2'])
    expect([...(latest?.selected ?? [])].sort()).toEqual(['a', 'b'])
  })

  it('starts empty when the stored document is corrupt', async () => {
    localStorage.setItem(COPILOT_QUEUE_STORAGE_KEY, '{oops')
    await renderQueue()

    expect(latest?.entries).toEqual([])
    expect(latest?.selected.size).toBe(0)
  })

  it('adds entries, selects the new ones and persists the queue', async () => {
    await renderQueue()
    await run(() => {
      latest?.add([entry('a', 'prts://1')])
    })

    expect(latest?.entries.map(item => item.uri)).toEqual(['prts://1'])
    expect(latest?.selected.has('a')).toBe(true)
    expect(readStored().map(item => item.uri)).toEqual(['prts://1'])

    let added = 0
    await run(() => {
      added = latest?.add([entry('a-again', 'prts://1'), entry('b', 'prts://2')]) ?? 0
    })

    expect(added).toBe(1)
    expect(latest?.entries.map(item => item.uri)).toEqual(['prts://1', 'prts://2'])
    expect([...(latest?.selected ?? [])].sort()).toEqual(['a', 'b'])
    expect(readStored()).toHaveLength(2)
  })

  it('removes entries from the selection and persists the change', async () => {
    localStorage.setItem(COPILOT_QUEUE_STORAGE_KEY, serializeCopilotQueue([
      entry('a', 'prts://1'),
      entry('b', 'prts://2'),
    ]))
    await renderQueue()

    await run(() => latest?.remove('a'))

    expect(latest?.entries.map(item => item.id)).toEqual(['b'])
    expect([...(latest?.selected ?? [])]).toEqual(['b'])
    expect(readStored().map(item => item.id)).toEqual(['b'])
  })

  it('moves entries, toggles single and all selections, and clears the queue', async () => {
    localStorage.setItem(COPILOT_QUEUE_STORAGE_KEY, serializeCopilotQueue([
      entry('a', 'prts://1'),
      entry('b', 'prts://2'),
    ]))
    await renderQueue()

    await run(() => latest?.move('b', 'up'))
    expect(latest?.entries.map(item => item.id)).toEqual(['b', 'a'])

    await run(() => latest?.toggle('b'))
    expect([...(latest?.selected ?? [])]).toEqual(['a'])

    await run(() => latest?.toggleAll())
    expect([...(latest?.selected ?? [])].sort()).toEqual(['a', 'b'])

    await run(() => latest?.clear())
    expect(latest?.entries).toEqual([])
    expect(latest?.selected.size).toBe(0)
    expect(readStored()).toEqual([])
  })

  it('syncs set members in place while preserving custom entries and checked indexes', async () => {
    localStorage.setItem(COPILOT_QUEUE_STORAGE_KEY, serializeCopilotQueue([
      entry('custom', 'prts://900'),
    ]))
    await renderQueue()

    await run(() => latest?.syncSet('48990', [setEntry('first-0', 0), setEntry('first-1', 1)], [0, 1]))

    expect(latest?.entries.map(item => item.id)).toEqual(['custom', 'first-0', 'first-1'])
    expect([...(latest?.selected ?? [])].sort()).toEqual(['custom', 'first-0', 'first-1'])

    await run(() => latest?.syncSet('48990', [setEntry('next-0', 0), setEntry('next-1', 1)], [1]))

    expect(latest?.entries.map(item => item.id)).toEqual(['custom', 'first-0', 'first-1'])
    expect(latest?.entries[0]?.uri).toBe('prts://900')
    expect(latest?.entries[1]).toMatchObject({ setId: '48990', setItemIndex: 0 })
    expect([...(latest?.selected ?? [])].sort()).toEqual(['custom', 'first-1'])
    expect(readStored()).toHaveLength(3)
  })

  it('refreshes existing set rows without restoring removed or unchecked members', async () => {
    const members = [setEntry('a', 0), setEntry('b', 1), setEntry('c', 2)]
    localStorage.setItem(COPILOT_QUEUE_STORAGE_KEY, serializeCopilotQueue(members))
    await renderQueue()
    await run(() => {
      latest?.move('b', 'up')
      latest?.toggle('b')
      latest?.remove('c')
    })

    await run(() => latest?.syncSet('48990', [
      { ...setEntry('a-fresh', 0), completedModes: ['normal'] },
      setEntry('b-fresh', 1),
      setEntry('c-fresh', 2),
    ], [1, 2], 'refresh'))

    expect(latest?.entries.map(item => item.id)).toEqual(['b', 'a'])
    expect(latest?.entries.find(item => item.id === 'a')?.completedModes).toEqual(['normal'])
    expect(latest?.selected.size).toBe(0)
    expect(readStored().map(item => item.id)).toEqual(['b', 'a'])
  })

  it('keeps working when localStorage rejects writes', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    await renderQueue()

    await run(() => {
      latest?.add([entry('a', 'prts://1')])
    })

    expect(latest?.entries.map(item => item.uri)).toEqual(['prts://1'])
    expect(latest?.selected.has('a')).toBe(true)
  })
})
