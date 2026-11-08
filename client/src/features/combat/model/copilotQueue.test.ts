// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CopilotSetInfo } from '../types'
import {
  addCopilotQueueEntries,
  buildCopilotQueueEntries,
  buildCopilotQueueEntryFromFile,
  checkedCopilotQueueEntries,
  COPILOT_QUEUE_LIMIT,
  copilotQueueEntryArgument,
  moveCopilotQueueEntry,
  parseCopilotQueueFileContent,
  removeCopilotQueueEntry,
  toggleAllCopilotQueueSelection,
  toggleCopilotQueueSelection,
  type CopilotQueueEntry,
} from './copilotQueue'

const entry = (overrides: Partial<CopilotQueueEntry> = {}): CopilotQueueEntry => ({
  id: overrides.id ?? `id-${overrides.uri ?? 'entry'}`,
  source: overrides.source ?? 'link',
  uri: overrides.uri ?? 'prts://100',
  title: overrides.title ?? '作业',
  addedAt: overrides.addedAt ?? 1_000,
  ...overrides,
})

const setPreview = (): CopilotSetInfo => ({
  type: 'set',
  id: '48990',
  name: '作业集 48990',
  copilots: [
    {
      id: 101,
      name: '关卡一',
      stage: 'TEST-1',
      stageId: 'test_1',
      apCost: 18,
      uri: 'prts://101',
      supportsRaid: true,
      completedModes: ['normal'],
      operators: '能天使、[重装]',
      operatorDetails: [{ name: '能天使', elite: 2, level: 60 }],
      groupNames: ['重装'],
    },
    {
      id: 102,
      stage: 'TEST-2',
      apCost: null,
      uri: 'prts://102',
      presetFormation: true,
    },
  ],
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('copilot queue entries', () => {
  it('expands a set preview into ordered member entries', () => {
    const entries = buildCopilotQueueEntries(setPreview(), 42)

    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      source: 'set',
      uri: 'prts://101',
      title: '关卡一',
      stage: 'TEST-1',
      stageId: 'test_1',
      apCost: 18,
      supportsRaid: true,
      operators: ['能天使'],
      groups: ['重装'],
      operatorDetails: [{ name: '能天使', elite: 2, level: 60 }],
      completedModes: ['normal'],
      setId: '48990',
      setItemIndex: 0,
      addedAt: 42,
    })
    expect(entries[1]).toMatchObject({
      source: 'set',
      uri: 'prts://102',
      title: 'TEST-2',
      apCost: null,
      presetFormation: true,
      setId: '48990',
      setItemIndex: 1,
    })
    expect(new Set(entries.map(item => item.id)).size).toBe(2)
  })

  it('builds a link entry from a single preview', () => {
    const [item] = buildCopilotQueueEntries({
      type: 'single',
      id: '1234',
      name: '单作业',
      stage: '1-7',
      operators: '艾雅法拉、[近卫]',
      operatorDetails: [{ name: '艾雅法拉', elite: 2, level: 90 }],
      groupNames: ['近卫'],
    }, 7)

    expect(item).toMatchObject({
      source: 'link',
      uri: 'prts://1234',
      title: '单作业',
      stage: '1-7',
      operators: ['艾雅法拉'],
      groups: ['近卫'],
      operatorDetails: [{ name: '艾雅法拉', elite: 2, level: 90 }],
      addedAt: 7,
    })
    expect(item?.setId).toBeUndefined()
  })

  it('reads local file metadata and keeps the file name fallback', () => {
    const metadata = parseCopilotQueueFileContent(JSON.stringify({
      stage_name: 'CE-6',
      doc: { title: '钱本作业' },
      opers: [{ name: '桃金娘' }, { name: '德克萨斯' }],
      groups: [{ name: '先锋' }],
    }))
    expect(metadata).toEqual({
      title: '钱本作业',
      stage: 'CE-6',
      operators: ['桃金娘', '德克萨斯'],
      groups: ['先锋'],
    })

    const valid = buildCopilotQueueEntryFromFile('/data/a.json', 'local.json', JSON.stringify({
      doc: { title: '本地作业' },
      stage_name: '1-7',
      opers: [{ name: '能天使' }],
    }))
    expect(valid).toMatchObject({
      source: 'file',
      uri: '/data/a.json',
      title: '本地作业',
      stage: '1-7',
      operators: ['能天使'],
      fileName: 'local.json',
    })

    const fallback = buildCopilotQueueEntryFromFile('/data/b.json', 'broken.json', 'not-json')
    expect(fallback).toMatchObject({
      source: 'file',
      title: 'broken',
      fileName: 'broken.json',
    })
    expect(fallback.stage).toBeUndefined()
  })

  it('quotes local file paths for the execution input', () => {
    expect(copilotQueueEntryArgument(entry({ source: 'file', uri: '/data/my job.json' })))
      .toBe('"/data/my job.json"')
    expect(copilotQueueEntryArgument(entry({ uri: 'prts://101' }))).toBe('prts://101')
  })
})

describe('copilot queue mutations', () => {
  it('adds by unique uri and stops at the queue limit', () => {
    const current = [entry({ id: 'a', uri: 'prts://1' })]
    const result = addCopilotQueueEntries(current, [
      entry({ id: 'b', uri: 'prts://1' }),
      entry({ id: 'c', uri: 'prts://2' }),
      entry({ id: 'd', uri: 'prts://3' }),
    ])

    expect(result.added).toBe(2)
    expect(result.entries.map(item => item.uri)).toEqual(['prts://1', 'prts://2', 'prts://3'])

    const full = Array.from({ length: COPILOT_QUEUE_LIMIT }, (_, index) => entry({
      id: `full-${index}`,
      uri: `prts://full-${index}`,
    }))
    expect(addCopilotQueueEntries(full, [entry({ uri: 'prts://overflow' })]).added).toBe(0)
    expect(addCopilotQueueEntries(full, [entry({ uri: 'prts://overflow' })]).entries).toHaveLength(COPILOT_QUEUE_LIMIT)
  })

  it('removes and moves entries without losing the remaining order', () => {
    const entries = [
      entry({ id: 'a', uri: 'prts://1' }),
      entry({ id: 'b', uri: 'prts://2' }),
      entry({ id: 'c', uri: 'prts://3' }),
    ]

    expect(removeCopilotQueueEntry(entries, 'b').map(item => item.id)).toEqual(['a', 'c'])
    expect(removeCopilotQueueEntry(entries, 'missing').map(item => item.id)).toEqual(['a', 'b', 'c'])
    expect(moveCopilotQueueEntry(entries, 'b', 'up').map(item => item.id)).toEqual(['b', 'a', 'c'])
    expect(moveCopilotQueueEntry(entries, 'b', 'down').map(item => item.id)).toEqual(['a', 'c', 'b'])
    expect(moveCopilotQueueEntry(entries, 'a', 'up').map(item => item.id)).toEqual(['a', 'b', 'c'])
    expect(moveCopilotQueueEntry(entries, 'c', 'down').map(item => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('toggles one or all entries and keeps checked order', () => {
    const entries = [
      entry({ id: 'a', uri: 'prts://1' }),
      entry({ id: 'b', uri: 'prts://2' }),
    ]

    const selected = toggleCopilotQueueSelection(new Set(), 'b')
    expect([...selected]).toEqual(['b'])
    expect(toggleCopilotQueueSelection(selected, 'b').size).toBe(0)
    expect([...toggleAllCopilotQueueSelection(entries, selected)].sort()).toEqual(['a', 'b'])
    expect(toggleAllCopilotQueueSelection(entries, new Set(['a', 'b'])).size).toBe(0)
    expect(checkedCopilotQueueEntries(entries, new Set(['b'])).map(item => item.id)).toEqual(['b'])
  })
})
