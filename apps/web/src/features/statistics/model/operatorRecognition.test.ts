import { describe, expect, it } from 'vitest'
import { describeOperBoxRecognitionHint } from './operatorRecognition'

describe('statistics operator recognition hint', () => {
  it('stays silent for complete snapshots and legacy payloads without the field', () => {
    expect(describeOperBoxRecognitionHint(undefined)).toBeNull()
    expect(describeOperBoxRecognitionHint({ status: 'complete', total: 335, owned: 120 })).toBeNull()
  })

  it('explains that a snapshot without the recognition catalog cannot confirm unowned operators', () => {
    expect(describeOperBoxRecognitionHint({ status: 'partial', total: 120, owned: 120 }))
      .toBe('识别快照缺少完整干员目录：未列出的干员拥有状态尚未确认，重新识别后可确认。')
  })
})
