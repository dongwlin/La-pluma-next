// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InfrastScheduleField from './InfrastScheduleField'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const setInputValue = async (input: HTMLInputElement, value: string) => {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    valueSetter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const renderField = async (props: {
  filename?: string
  planIndex?: number | string
  onChange: (key: 'filename' | 'plan_index', value: string | number) => void
}) => {
  await act(async () => {
    root.render(
      <InfrastScheduleField
        fieldId="automation-infrast-1-filename"
        filename={props.filename ?? ''}
        planIndex={props.planIndex ?? 0}
        disabled={false}
        onChange={props.onChange}
      />,
    )
  })
}

describe('InfrastScheduleField', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('shows the clamped plan index and stores a normalized value', async () => {
    const onChange = vi.fn()
    await renderField({ filename: 'base.json', planIndex: -3, onChange })

    const planInput = document.querySelector<HTMLInputElement>('#automation-infrast-1-filename-plan-index')
    if (!planInput) throw new Error('missing plan index input')
    expect(planInput.value).toBe('0')

    await setInputValue(planInput, '2')
    expect(onChange).toHaveBeenLastCalledWith('plan_index', 2)

    await setInputValue(planInput, '-1')
    expect(onChange).toHaveBeenLastCalledWith('plan_index', 0)
  })

  it('writes the filename through the task parameter channel', async () => {
    const onChange = vi.fn()
    await renderField({ filename: 'base.json', planIndex: 0, onChange })

    const filenameInput = document.querySelector<HTMLInputElement>('#automation-infrast-1-filename-filename')
    if (!filenameInput) throw new Error('missing filename input')
    await setInputValue(filenameInput, 'schedules/base.json')

    expect(onChange).toHaveBeenLastCalledWith('filename', 'schedules/base.json')
  })
})
