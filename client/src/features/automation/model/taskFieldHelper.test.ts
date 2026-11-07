import { describe, expect, it } from 'vitest'
import type { TaskParamField } from '../types'
import { resolveFieldHelperTooltip } from './taskFieldHelper'

const fieldWith = (overrides: Partial<TaskParamField>): TaskParamField => ({
  key: 'accountName',
  label: '切换账号',
  type: 'text',
  helper: '输入已登录账号的部分字符即可',
  ...overrides,
})

describe('resolveFieldHelperTooltip', () => {
  it('returns the helper only when the field asks for a tooltip', () => {
    expect(resolveFieldHelperTooltip(fieldWith({ helperPlacement: 'tooltip' })))
      .toBe('输入已登录账号的部分字符即可')
    expect(resolveFieldHelperTooltip(fieldWith({ helperPlacement: 'below' }))).toBeUndefined()
    expect(resolveFieldHelperTooltip(fieldWith({}))).toBeUndefined()
  })

  it('falls back to the inline helper for layouts without a tooltip trigger', () => {
    for (const type of [
      'multi-stages',
      'facility-select',
      'stage-with-times',
      'infrast-schedule',
      'oper-progress-plans',
      'theme-list',
    ] as const) {
      expect(resolveFieldHelperTooltip(fieldWith({ type, helperPlacement: 'tooltip' }))).toBeUndefined()
    }
  })

  it('supports the row, checkbox and fieldset legend layouts that own a hint trigger', () => {
    for (const type of ['text', 'number', 'select', 'checkbox', 'star-select'] as const) {
      expect(resolveFieldHelperTooltip(fieldWith({ type, helperPlacement: 'tooltip' }))).toBeDefined()
    }
  })

  it('never invents a hint for a field without helper copy', () => {
    expect(resolveFieldHelperTooltip(fieldWith({ helper: undefined, helperPlacement: 'tooltip' }))).toBeUndefined()
  })
})
