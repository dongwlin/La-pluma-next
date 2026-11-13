// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { COPILOT_QUEUE_LIMIT, type CopilotQueueEntry } from './copilotQueue'
import {
  COPILOT_QUEUE_STORAGE_KEY,
  parseCopilotQueue,
  readCopilotQueueStorage,
  serializeCopilotQueue,
  writeCopilotQueueStorage,
} from './copilotQueueStorage'

const entry = (overrides: Partial<CopilotQueueEntry> = {}): CopilotQueueEntry => ({
  id: overrides.id ?? `id-${overrides.uri ?? 'entry'}`,
  source: overrides.source ?? 'link',
  uri: overrides.uri ?? 'prts://100',
  title: overrides.title ?? '作业',
  addedAt: overrides.addedAt ?? 1_000,
  ...overrides,
})

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('copilot queue serialization', () => {
  it('round-trips entries through the versioned document', () => {
    const entries = [
      entry({ id: 'a', uri: 'prts://101' }),
      entry({ id: 'b', uri: '/data/b.json', source: 'file' }),
      entry({
        id: 'c',
        uri: 'prts://102',
        source: 'set',
        setId: '48990',
        setItemIndex: 2,
        operatorDetails: [{ name: '能天使', elite: 2, level: 60 }],
        details: '作者：A\nhttps://www.bilibili.com/video/BV1xx411c7mD',
      }),
    ]
    const parsed = parseCopilotQueue(serializeCopilotQueue(entries))

    expect(parsed.map(item => item.id)).toEqual(['a', 'b', 'c'])
    expect(parsed[1]).toMatchObject({ source: 'file', uri: '/data/b.json' })
    expect(parsed[2]).toMatchObject({
      setId: '48990',
      setItemIndex: 2,
      operatorDetails: [{ name: '能天使', elite: 2, level: 60 }],
      details: '作者：A\nhttps://www.bilibili.com/video/BV1xx411c7mD',
    })
  })

  it('drops invalid documents, unknown versions and invalid entries', () => {
    expect(parseCopilotQueue('not-json')).toEqual([])
    expect(parseCopilotQueue(JSON.stringify({ version: 2, entries: [entry()] }))).toEqual([])
    expect(parseCopilotQueue(JSON.stringify({ version: 1, entries: 'nope' }))).toEqual([])
    expect(parseCopilotQueue(JSON.stringify({
      version: 1,
      entries: [
        entry({ id: 'a', uri: 'prts://1' }),
        { id: 'missing-uri', source: 'link', title: '坏数据' },
        { id: 'bad-source', source: 'remote', uri: 'prts://3' },
        entry({ id: 'duplicate', uri: 'prts://1' }),
      ],
    })).map(item => item.id)).toEqual(['a'])
  })

  it('truncates stored queues at the limit', () => {
    const entries = Array.from({ length: COPILOT_QUEUE_LIMIT + 5 }, (_, index) => entry({
      id: `entry-${index}`,
      uri: `prts://${index}`,
    }))
    const parsed = parseCopilotQueue(serializeCopilotQueue(entries))
    expect(parsed).toHaveLength(COPILOT_QUEUE_LIMIT)
    expect(parsed[parsed.length - 1]?.uri).toBe(`prts://${COPILOT_QUEUE_LIMIT - 1}`)
  })

  it('persists and reloads the queue, tolerating storage failures', () => {
    const entries = [entry({ id: 'a', uri: 'prts://101' })]
    expect(writeCopilotQueueStorage(entries)).toBe(true)
    expect(readCopilotQueueStorage().map(item => item.uri)).toEqual(['prts://101'])
    expect(localStorage.getItem(COPILOT_QUEUE_STORAGE_KEY)).toContain('"version":1')

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    expect(writeCopilotQueueStorage(entries)).toBe(false)

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(readCopilotQueueStorage()).toEqual([])
  })
})
