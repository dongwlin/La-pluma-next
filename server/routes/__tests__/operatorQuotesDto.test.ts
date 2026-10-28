import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parseCreateQuoteBody,
  parseOperatorName,
  parseQuoteText,
  parseUpdateQuoteBody
} from '../operatorQuotesDto.ts'

// 台词写接口的输入边界：合法输入 trim 后交给服务，非法输入保持旧业务文案，
// 由 router 以裸 `{ error }` / 400 返回（HTTP 形状由台词持久化 fixture 覆盖）。
describe('operator quotes request parsing', () => {
  it('trims a valid create body and drops unknown fields', () => {
    assert.deepEqual(
      parseCreateQuoteBody({ operator: ' 测试干员 ', quote: ' 台词正文 ', extraField: 'ignored' }),
      { ok: true, value: { operator: '测试干员', quote: '台词正文' } }
    )
  })

  it('answers the legacy missing-field message for non-object or incomplete bodies', () => {
    for (const body of [undefined, null, 'text', 42, ['array']]) {
      assert.deepEqual(parseCreateQuoteBody(body), { ok: false, error: '缺少干员名或台词' })
    }
    assert.deepEqual(parseCreateQuoteBody({}), { ok: false, error: '缺少干员名或台词' })
    assert.deepEqual(parseCreateQuoteBody({ operator: 42, quote: '台词' }), { ok: false, error: '缺少干员名或台词' })
    assert.deepEqual(parseCreateQuoteBody({ operator: '阿米娅', quote: '   ' }), { ok: false, error: '缺少干员名或台词' })
  })

  it('checks the operator name before the quote text and enforces both length limits', () => {
    assert.deepEqual(
      parseCreateQuoteBody({ operator: 'x'.repeat(101), quote: '' }),
      { ok: false, error: '干员名长度不能超过 100 个字符' }
    )
    assert.deepEqual(
      parseCreateQuoteBody({ operator: '阿米娅', quote: 'x'.repeat(2001) }),
      { ok: false, error: '台词长度不能超过 2000 个字符' }
    )
    assert.deepEqual(
      parseCreateQuoteBody({ operator: 'x'.repeat(100), quote: 'x'.repeat(2000) }),
      { ok: true, value: { operator: 'x'.repeat(100), quote: 'x'.repeat(2000) } }
    )
  })

  it('parses update bodies with the update-specific missing message', () => {
    assert.deepEqual(parseUpdateQuoteBody({ quote: ' 新台词 ' }), { ok: true, value: '新台词' })
    for (const body of [undefined, null, {}, { quote: 42 }, { quote: '' }, { quote: '   ' }]) {
      assert.deepEqual(parseUpdateQuoteBody(body), { ok: false, error: '缺少台词内容' })
    }
    assert.deepEqual(
      parseUpdateQuoteBody({ quote: 'x'.repeat(2001) }),
      { ok: false, error: '台词长度不能超过 2000 个字符' }
    )
  })

  it('exposes single-field parsing with the same boundaries', () => {
    assert.deepEqual(parseOperatorName(' 阿米娅 '), { ok: true, value: '阿米娅' })
    assert.deepEqual(parseOperatorName(''), { ok: false, error: '缺少干员名或台词' })
    assert.deepEqual(parseQuoteText(undefined, '缺少台词内容'), { ok: false, error: '缺少台词内容' })
    assert.deepEqual(parseQuoteText('台词', '缺少台词内容'), { ok: true, value: '台词' })
  })
})
