import { describe, expect, it } from 'vitest'
import {
  buildCopilotSetItemFromDetail,
  buildCopilotSetPreview,
  buildFallbackCopilotSetItem,
  buildSingleCopilotPreview,
  buildUnresolvedCopilotSetPreview,
  INVALID_COPILOT_URI_MESSAGE,
  resolveCopilotPreviewTarget,
} from './copilotPreview'

describe('resolveCopilotPreviewTarget', () => {
  it.each([
    ['prts://1234', 'auto', { id: '1234', kind: 'single', autoAddS: true }],
    ['PRTS://S1234', 'auto', { id: '1234', kind: 'set', autoAddS: false }],
    ['https://prts.plus/?op=1234', 'auto', { id: '1234', kind: 'probe', autoAddS: true }],
    ['https://prts.plus/?op=106833&opset=1234', 'auto', { id: '1234', kind: 'set', autoAddS: false }],
    ['prts://1234', 'set', { id: '1234', kind: 'set', autoAddS: true }],
    ['prts://s1234', 'single', { id: '1234', kind: 'single', autoAddS: false }],
    ['prts://s1234', 'auto', { id: '1234', kind: 'set', autoAddS: false }],
  ])('resolves %s with mode %s', (input, mode, expected) => {
    expect(resolveCopilotPreviewTarget(input, mode as 'auto' | 'single' | 'set')).toEqual(expected)
  })

  it('uses the first token of a multi-line input', () => {
    expect(resolveCopilotPreviewTarget(' prts://12\nprts://34 ', 'auto'))
      .toEqual({ id: '12', kind: 'single', autoAddS: true })
  })

  it('rejects inputs that are not copilot URIs or prts.plus links', () => {
    expect(resolveCopilotPreviewTarget('', 'auto')).toBeNull()
    expect(resolveCopilotPreviewTarget('/tmp/copilot.json', 'auto')).toBeNull()
    expect(resolveCopilotPreviewTarget('maa://1234', 'auto')).toBeNull()
    expect(INVALID_COPILOT_URI_MESSAGE).toContain('prts://')
  })
})

describe('preview builders', () => {
  it('builds a single preview with stage and operators', () => {
    expect(buildSingleCopilotPreview('12', {
      title: '低配 1-7',
      stage: '1-7',
      operators: '桃金娘',
    })).toEqual({
      type: 'single',
      id: '12',
      name: '低配 1-7',
      stage: '1-7',
      operators: '桃金娘',
    })
  })

  it('builds a set preview with the legacy name and note', () => {
    expect(buildCopilotSetPreview('48990', [
      { id: 101, stage: 'TEST-1', uri: 'prts://101' },
    ], false)).toEqual({
      type: 'set',
      id: '48990',
      name: '作业集 (1 个作业)',
      note: '包含多个关卡，将按顺序执行',
      autoAddS: false,
      copilots: [{ id: 101, stage: 'TEST-1', uri: 'prts://101' }],
      currentIndex: 0,
    })
  })

  it('keeps the legacy unresolved-set fallback and s-prefix note', () => {
    expect(buildUnresolvedCopilotSetPreview('1234', true)).toMatchObject({
      type: 'set',
      id: '1234',
      name: '作业集',
      note: '当前接口未返回 1234 的明细，执行时将按作业集处理（自动添加 s 前缀）',
      autoAddS: true,
      copilots: [],
    })
    expect(buildUnresolvedCopilotSetPreview('1234', false).note)
      .toBe('当前接口未返回 1234 的明细，执行时将按作业集处理')
  })

  it('builds set items from detail or a bare executable id', () => {
    expect(buildCopilotSetItemFromDetail(101, {
      title: '测试作业',
      stage: 'TEST-1',
      operators: '临光',
    })).toEqual({
      id: 101,
      name: '测试作业',
      stage: 'TEST-1',
      operators: '临光',
      uri: 'prts://101',
    })
    expect(buildFallbackCopilotSetItem(101)).toEqual({ id: 101, uri: 'prts://101' })
  })
})
