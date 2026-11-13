import { describe, expect, it } from 'vitest'
import { describeRecognitionHint } from './recognition'

describe('training recognition hint', () => {
  it('stays silent for complete recognition and missing summaries', () => {
    expect(describeRecognitionHint(null)).toBeNull()
    expect(describeRecognitionHint({
      status: 'complete',
      recognizedAt: '2026-11-06T00:00:00.000Z',
      total: 335,
      owned: 120,
      unknown: 0,
      missing: [],
    })).toBeNull()
  })

  it('explains that ownership is unknown before the first recognition', () => {
    expect(describeRecognitionHint({
      status: 'missing',
      recognizedAt: null,
      total: 335,
      owned: 0,
      unknown: 335,
      missing: [],
    })).toEqual({
      tone: 'info',
      message: '尚未识别干员：未拥有状态未知，请先在“数据统计”完成一次干员识别。',
    })
  })

  it('reports how many operators remain unconfirmed in a partial recognition', () => {
    expect(describeRecognitionHint({
      status: 'partial',
      recognizedAt: '2026-11-06T00:00:00.000Z',
      total: 335,
      owned: 120,
      unknown: 2,
      missing: ['char_1', 'char_2'],
    })).toEqual({
      tone: 'warning',
      message: '识别不完整：2 名干员的拥有状态未确认，列表中按“未识别”显示。',
    })
  })
})
