// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  extractCopilotOperators,
  readCopilotInfoPayload,
  readCopilotPlanPayload,
  readCopilotSearchResult,
  readCopilotSetPayload,
  readCopilotStageCandidates,
  readCopilotStageCatalog,
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

  it('reads the extended card fields and filters unusable list values', () => {
    const result = readCopilotSearchResult(envelope({
      keyword: '1-7',
      stage: '1-7',
      stageId: 'main_01-07',
      orderBy: 'views',
      page: 2,
      limit: 30,
      total: 41,
      hasNext: true,
      copilots: [{
        id: 5,
        uri: 'prts://5',
        views: 1,
        hotScore: 2,
        stageName: '1-7',
        stageId: 'main_01-07',
        stageCode: '1-7',
        stageLabel: '风暴瞭望',
        uploader: '博士',
        uploadTime: '2026-01-01 10:00:00',
        operators: ['阿米娅', '凯尔希', '', 7, '阿米娅'],
        match: {
          mode: 'borrow',
          missing: ['凯尔希'],
          training: [],
          check: ['桃金娘', '桃金娘'],
          totalSlots: 12,
        },
      }],
    }))

    expect(result).toEqual({
      keyword: '1-7',
      stage: '1-7',
      stageId: 'main_01-07',
      orderBy: 'views',
      page: 2,
      limit: 30,
      total: 41,
      hasNext: true,
      copilots: [{
        id: '5',
        uri: 'prts://5',
        views: 1,
        hotScore: 2,
        stageName: '1-7',
        stageId: 'main_01-07',
        stageCode: '1-7',
        stageLabel: '风暴瞭望',
        uploader: '博士',
        uploadTime: '2026-01-01 10:00:00',
        operators: ['阿米娅', '凯尔希'],
        match: { mode: 'borrow', missing: ['凯尔希'], training: [], check: ['桃金娘'], totalSlots: 12 },
      }],
    })
  })

  it('omits invalid paging and match values instead of guessing', () => {
    const result = readCopilotSearchResult(envelope({
      stage: '1-7',
      orderBy: 'popular',
      page: 0,
      limit: 1.5,
      total: -1,
      hasNext: 'yes',
      copilots: [
        { uri: 'prts://1', match: { mode: 'unknown', totalSlots: 12 } },
        { uri: 'prts://2', match: { mode: 'ready', totalSlots: '12' } },
        { uri: 'prts://3', match: { mode: 'ready', totalSlots: 12, missing: '阿米娅' } },
      ],
    }))

    expect(result).toEqual({
      stage: '1-7',
      copilots: [
        { id: 'prts://1', uri: 'prts://1', views: 0, hotScore: 0 },
        { id: 'prts://2', uri: 'prts://2', views: 0, hotScore: 0 },
        {
          id: 'prts://3',
          uri: 'prts://3',
          views: 0,
          hotScore: 0,
          match: { mode: 'ready', missing: [], training: [], check: [], totalSlots: 12 },
        },
      ],
    })
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

describe('copilot stage candidates', () => {
  it('reads candidate stages from ambiguous-search error details', () => {
    expect(readCopilotStageCandidates({
      stage: 'LT-2',
      candidates: [
        { stageId: 'lt_02_01', code: 'LT-2', name: '未授权区域', category: '保全派驻', zone: '塔山农业实验平台' },
        { stageId: 'lt_02_02', code: 'LT-2', name: '临时通道' },
        { name: '缺少标识' },
        'not-a-record',
      ],
    })).toEqual([
      { stageId: 'lt_02_01', code: 'LT-2', name: '未授权区域', category: '保全派驻', zone: '塔山农业实验平台' },
      { stageId: 'lt_02_02', code: 'LT-2', name: '临时通道', category: '', zone: '' },
    ])
  })

  it('returns an empty list for unrelated details', () => {
    expect(readCopilotStageCandidates(null)).toEqual([])
    expect(readCopilotStageCandidates({ stage: '1-7' })).toEqual([])
    expect(readCopilotStageCandidates([])).toEqual([])
  })
})

describe('copilot stage catalog', () => {
  it('reads the catalog array and keeps the first entry per stageId', () => {
    expect(readCopilotStageCatalog([
      { stageId: 'main_01-07', code: '1-7', name: '风暴瞭望', category: '主线', zone: '切尔诺伯格' },
      { stageId: 'main_01-07', code: '1-7', name: '重复条目' },
      { name: '缺少标识' },
      'not-a-record',
      null,
    ])).toEqual([
      { stageId: 'main_01-07', code: '1-7', name: '风暴瞭望', category: '主线', zone: '切尔诺伯格' },
    ])
  })

  it('treats an empty catalog as valid and a non-array as invalid', () => {
    expect(readCopilotStageCatalog([])).toEqual([])
    expect(readCopilotStageCatalog({ stages: [] })).toBeNull()
    expect(readCopilotStageCatalog(null)).toBeNull()
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
        stageId: '1-7',
        operators: '桃金娘、阿米娅、[击杀组]',
        operatorDetails: [{ name: '桃金娘' }, { name: '阿米娅' }],
        groupNames: ['击杀组'],
      },
    })
  })

  it('keeps operator requirements and coerces numeric module ids', () => {
    const result = readCopilotInfoPayload({
      status_code: 200,
      data: {
        content: {
          opers: [
            { name: '桃金娘', requirements: { elite: 2, level: 60, skill_level: 10, module: 1 } },
            { name: '临光', requirements: { elite: 0, level: 1 } },
            { name: '' },
            { requirements: { elite: 2 } },
          ],
          groups: [{ name: '击杀组' }, { name: '' }, null],
        },
      },
    })

    expect(result.detail?.operatorDetails).toEqual([
      { name: '桃金娘', elite: 2, level: 60, skillLevel: 10, module: '1' },
      { name: '临光', elite: 0, level: 1 },
    ])
    expect(result.detail?.groupNames).toEqual(['击杀组'])
    expect(result.detail?.operators).toBe('桃金娘、临光、[击杀组]')
  })

  it('reads the author description verbatim and drops blank ones', () => {
    const details = '作者：緊急失控\nhttps://www.bilibili.com/video/BV1FrWJ6nESh'
    const described = readCopilotInfoPayload(envelope({
      status_code: 200,
      data: {
        content: JSON.stringify({
          stage_name: 'TL-EX-3',
          doc: { title: 'TL-EX-3', details },
        }),
      },
    }))
    expect(described.detail?.details).toBe(details)

    const blank = readCopilotInfoPayload(envelope({
      status_code: 200,
      data: { content: JSON.stringify({ stage_name: '1-7', doc: { details: '  ' } }) },
    }))
    expect(blank.detail?.details).toBeUndefined()
  })

  it('accepts an already parsed content object and falls back to the unnamed title', () => {
    const result = readCopilotInfoPayload({
      status_code: 200,
      data: { content: { stage_name: 'CE-6' } },
    })

    expect(result.detail).toEqual({
      title: '未命名作业',
      stage: 'CE-6',
      stageId: 'CE-6',
      operators: '未知',
    })
  })

  it('prefers the server-resolved stage code and keeps the raw stage id', () => {
    const result = readCopilotInfoPayload(envelope({
      status_code: 200,
      stage: 'TL-EX-3',
      stageId: 'act55side_ex03',
      data: {
        content: JSON.stringify({
          stage_name: 'act55side_ex03',
          doc: { title: '时间啊，向前！ - TL-EX-3 - 致远特维' },
        }),
      },
    }))

    expect(result.detail).toMatchObject({
      stage: 'TL-EX-3',
      stageId: 'act55side_ex03',
    })
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

  it('keeps the author description on plan members', () => {
    const details = '作者：A\nhttps://www.bilibili.com/video/BV1xx411c7mD'
    const result = readCopilotPlanPayload({
      items: [{ id: 7, details }, { id: 8, details: ' ' }],
      entries: [],
    })

    expect(result?.items[0]?.details).toBe(details)
    expect(result?.items[1]?.details).toBeUndefined()
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

  it('keeps known stage costs and drops missing costs', () => {
    const result = readCopilotPlanPayload({
      items: [
        { id: 1, stage: '1-7', apCost: 6 },
        { id: 2, stage: 'X-1', apCost: null },
        { id: 3 },
      ],
      entries: [],
    })

    expect(result).not.toBeNull()
    expect(result?.items[0]?.apCost).toBe(6)
    expect(result?.items[1]?.apCost).toBeUndefined()
    expect(result?.items[2]?.apCost).toBeUndefined()
  })

  it('keeps operator requirements and groups instead of dropping them', () => {
    const result = readCopilotPlanPayload({
      items: [{
        id: 201,
        operators: [
          { name: '桃金娘', requirements: { elite: 2, level: 60, skill_level: 10, module: 'χ' } },
          { name: '临光', requirements: { elite: 0, level: 1 } },
        ],
        groups: [{ name: '击杀组', opers: ['桃金娘'] }],
      }],
      entries: [],
    })

    expect(result?.items[0]).toMatchObject({
      id: 201,
      operatorDetails: [
        { name: '桃金娘', elite: 2, level: 60, skillLevel: 10, module: 'χ' },
        { name: '临光', elite: 0, level: 1 },
      ],
      groupNames: ['击杀组'],
    })
    expect(result?.items[0]?.operators).toBeUndefined()
  })

  it('rejects incomplete plans so callers can fall back to the set list', () => {
    expect(readCopilotPlanPayload({ items: [] })).toBeNull()
    expect(readCopilotPlanPayload({ entries: [] })).toBeNull()
    expect(readCopilotPlanPayload(envelope({ items: [], entries: 'bad' }))).toBeNull()
  })
})
