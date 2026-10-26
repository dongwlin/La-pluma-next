// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  extractCopilotOperators,
  readCopilotInfoPayload,
  readCopilotPlanPayload,
  readCopilotSearchResult,
  readCopilotSetPayload,
  readParadoxSearchResult,
  unwrapCopilotPayload,
} from './copilotPayload'

const envelope = (data: unknown) => ({ success: true, data, message: 'ok' })

describe('unwrapCopilotPayload', () => {
  it('unwraps success envelopes and keeps raw proxy payloads', () => {
    expect(unwrapCopilotPayload(envelope({ status_code: 200 }))).toEqual({ status_code: 200 })
    expect(unwrapCopilotPayload({ status_code: 200 })).toEqual({ status_code: 200 })
    expect(unwrapCopilotPayload(null)).toBeNull()
  })

  it('does not treat a failure envelope as a payload', () => {
    expect(unwrapCopilotPayload({ success: false, message: '未找到' }))
      .toEqual({ success: false, message: '未找到' })
  })
})

describe('copilot search payload', () => {
  it('normalizes the current enveloped shape and keeps the recommended uri', () => {
    const result = readCopilotSearchResult(envelope({
      stage: '1-7',
      copilots: [
        { id: 12, uri: 'prts://12', views: 30, hotScore: 4.5, stageName: '1-7', title: '作业 A' },
        { uri: 'prts://13', title: '作业 B' },
      ],
      recommended: { uri: 'prts://12' },
    }))

    expect(result).toEqual({
      stage: '1-7',
      copilots: [
        {
          id: '12',
          uri: 'prts://12',
          views: 30,
          hotScore: 4.5,
          stageName: '1-7',
          title: '作业 A',
        },
        { id: 'prts://13', uri: 'prts://13', views: 0, hotScore: 0, title: '作业 B' },
      ],
      recommended: { uri: 'prts://12' },
    })
  })

  it('accepts a raw payload and drops unusable entries or recommendations', () => {
    const result = readCopilotSearchResult({
      copilots: [
        { id: 1, uri: '', title: '无 uri' },
        { id: 2, uri: 'prts://2' },
        null,
      ],
      recommended: { id: 2 },
    })

    expect(result).toEqual({
      stage: '',
      copilots: [{ id: '2', uri: 'prts://2', views: 0, hotScore: 0 }],
    })
  })

  it('rejects payloads without a copilot list', () => {
    expect(readCopilotSearchResult({ stage: '1-7' })).toBeNull()
    expect(readCopilotSearchResult(null)).toBeNull()
  })

  it('reads paradox payloads with the operator name', () => {
    const result = readParadoxSearchResult(envelope({
      operator: '古米',
      copilots: [{ id: 7, uri: 'prts://7', views: 1, hotScore: 5 }],
      recommended: { uri: 'prts://7' },
    }))

    expect(result).toEqual({
      operator: '古米',
      copilots: [{ id: '7', uri: 'prts://7', views: 1, hotScore: 5 }],
      recommended: { uri: 'prts://7' },
    })
  })
})

describe('copilot detail payload', () => {
  const content = {
    stage_name: '1-7',
    doc: { title: '低配 1-7' },
    opers: [{ name: '桃金娘' }, { name: '阿米娅' }],
    groups: [{ name: '击杀组' }],
  }

  it('parses a JSON content string inside the PRTS proxy envelope', () => {
    const result = readCopilotInfoPayload(envelope({
      status_code: 200,
      data: { content: JSON.stringify(content) },
    }))

    expect(result).toEqual({
      statusCode: 200,
      detail: {
        title: '低配 1-7',
        stage: '1-7',
        operators: '桃金娘、阿米娅、[击杀组]',
      },
    })
  })

  it('accepts an already parsed content object and falls back to the unnamed title', () => {
    const result = readCopilotInfoPayload({
      status_code: 200,
      data: { content: { stage_name: 'CE-6' } },
    })

    expect(result.detail).toEqual({ title: '未命名作业', stage: 'CE-6', operators: '未知' })
  })

  it('keeps the status code for the legacy set probe when the copilot is missing', () => {
    expect(readCopilotInfoPayload(envelope({ status_code: 404, data: null }))).toEqual({
      statusCode: 404,
      detail: null,
    })
  })

  it('returns no detail for malformed content, missing status or bad JSON', () => {
    expect(readCopilotInfoPayload({ status_code: 200, data: { content: '{bad' } }).detail).toBeNull()
    expect(readCopilotInfoPayload({ status_code: 200, data: null }).detail).toBeNull()
    expect(readCopilotInfoPayload({ data: { content: JSON.stringify(content) } }).detail).toBeNull()
    expect(readCopilotInfoPayload(envelope('text')).detail).toBeNull()
  })

  it('extracts operator names and groups without leaking missing entries', () => {
    expect(extractCopilotOperators({})).toBe('未知')
    expect(extractCopilotOperators({
      opers: [null, { name: '' }, { name: '临光' }],
      groups: [{ name: '阻挡组' }],
    })).toBe('临光、[阻挡组]')
  })
})

describe('copilot set payload', () => {
  it('accepts numeric and numeric string ids and drops invalid values', () => {
    expect(readCopilotSetPayload(envelope({
      status_code: 200,
      data: { copilot_ids: [12, '13', 0, -1, 1.5, 'x', null, 12] },
    }))).toEqual({ statusCode: 200, ids: [12, 13] })
  })

  it('returns an empty list for a proxy error or a non-record payload', () => {
    expect(readCopilotSetPayload(envelope({ status_code: 404, data: null })))
      .toEqual({ statusCode: 404, ids: [] })
    expect(readCopilotSetPayload(null)).toEqual({ statusCode: null, ids: [] })
  })
})

describe('copilot plan payload', () => {
  const plan = {
    setId: '48990',
    name: '作业集 48990',
    items: [
      { id: 101, stage: 'TEST-1', stageId: 'test_1', supportsRaid: true },
      { id: 102, stageId: 'test_2', presetFormation: true, supportsRaid: false },
      { id: 0, stage: 'ignored' },
      null,
    ],
    entries: [
      { itemIndex: 0, mode: 'normal', completed: true },
      { itemIndex: 0, mode: 'normal', completed: true },
      { itemIndex: 0, mode: 'raid', completed: false },
      { itemIndex: 1, mode: 'normal', completed: true },
    ],
  }

  it('maps members and folds completed entries into each item', () => {
    expect(readCopilotPlanPayload(envelope(plan))).toEqual({
      setId: '48990',
      name: '作业集 48990',
      items: [
        {
          id: 101,
          name: 'TEST-1',
          stage: 'TEST-1',
          stageId: 'test_1',
          presetFormation: false,
          supportsRaid: true,
          completedModes: ['normal'],
          uri: 'prts://101',
        },
        {
          id: 102,
          name: '作业 #102',
          stageId: 'test_2',
          presetFormation: true,
          supportsRaid: false,
          completedModes: ['normal'],
          uri: 'prts://102',
        },
      ],
    })
  })

  it('normalizes missing names and accepts a raw payload', () => {
    const result = readCopilotPlanPayload({
      items: [{ id: 7 }],
      entries: [],
    })

    expect(result).toEqual({
      setId: '',
      name: '作业集',
      items: [{
        id: 7,
        name: '作业 #7',
        presetFormation: false,
        supportsRaid: true,
        uri: 'prts://7',
      }],
    })
  })

  it('rejects incomplete plans so callers can fall back to the set list', () => {
    expect(readCopilotPlanPayload({ items: [] })).toBeNull()
    expect(readCopilotPlanPayload({ entries: [] })).toBeNull()
    expect(readCopilotPlanPayload(envelope({ items: [], entries: 'bad' }))).toBeNull()
  })
})
