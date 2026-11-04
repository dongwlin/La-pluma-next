// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OperProgressPlan } from '../types'
import OperProgressPlansEditor from './OperProgressPlansEditor'
import ThemeListEditor from './ThemeListEditor'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const onPlans = vi.fn<(plans: OperProgressPlan[]) => void>()
const onThemes = vi.fn<(themes: string[]) => void>()

function Host({ disabled = false }: { disabled?: boolean }) {
  const [plans, setPlans] = useState<OperProgressPlan[]>([])
  const [themes, setThemes] = useState<string[]>([])
  return <>
    <OperProgressPlansEditor plans={plans} disabled={disabled} onChange={value => { setPlans(value); onPlans(value) }} />
    <ThemeListEditor themes={themes} disabled={disabled} onChange={value => { setThemes(value); onThemes(value) }} />
  </>
}

const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button')]
  .find(node => node.getAttribute('aria-label') === name || node.textContent === name)!
const click = async (name: string) => act(async () => button(name).click())
const setValue = async (name: string, value: string) => {
  const input = container.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${name}"]`)!
  await act(async () => {
    const prototype = input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
}

describe('game task editors', () => {
  it('shows an omitted profession as automatic inference without losing saved targets', async () => {
    await act(async () => root.render(<OperProgressPlansEditor plans={[{ name: '阿米娅', elite: 2 }]} disabled={false} onChange={onPlans} />))
    expect(container.querySelector<HTMLSelectElement>('[aria-label="培养计划 1 职业"]')?.value).toBe('Unknown')
    await setValue('培养计划 1 技能等级', '7')
    expect(onPlans).toHaveBeenLastCalledWith([{ name: '阿米娅', elite: 2, skill_level: 7 }])
  })

  beforeEach(async () => {
    onPlans.mockReset()
    onThemes.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(<Host />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('adds plans without a consumption target and edits optional goals as Core values', async () => {
    await click('添加培养计划')
    expect(onPlans).toHaveBeenLastCalledWith([{ role: 'Unknown', name: '' }])
    await setValue('培养计划 1 职业', 'Caster')
    await setValue('培养计划 1 干员姓名', '阿米娅')
    await setValue('培养计划 1 精英目标', '2')
    await setValue('培养计划 1 技能等级', '7')
    await setValue('培养计划 1 技能 2 专精', '3')
    expect(onPlans).toHaveBeenLastCalledWith([{ role: 'Caster', name: '阿米娅', elite: 2, skill_level: 7, skill_mastery: [0, 3, 0] }])
    await setValue('培养计划 1 精英目标', '')
    await setValue('培养计划 1 技能 2 专精', '0')
    expect(onPlans).toHaveBeenLastCalledWith([{ role: 'Caster', name: '阿米娅', skill_level: 7 }])
    await click('添加培养计划')
    await click('删除培养计划 1')
    expect(onPlans).toHaveBeenLastCalledWith([{ role: 'Unknown', name: '' }])
  })

  it('preserves the candidate theme list while editing and removing entries', async () => {
    await click('添加主题')
    await setValue('主题 1', '明日方舟')
    await click('添加主题')
    await setValue('主题 2', '新主题')
    expect(onThemes).toHaveBeenLastCalledWith(['明日方舟', '新主题'])
    await click('删除主题 1')
    expect(onThemes).toHaveBeenLastCalledWith(['新主题'])
  })

  it('disables editing and adding while execution owns the controls', async () => {
    await click('添加培养计划')
    await click('添加主题')
    await act(async () => root.render(<Host disabled />))
    expect([...container.querySelectorAll('input, select, button')].every(node => (node as HTMLInputElement).disabled)).toBe(true)
    expect(container.textContent).toContain('专精会占用训练室')
    expect(container.textContent).toContain('实际结果以执行详情为准')
  })
})
