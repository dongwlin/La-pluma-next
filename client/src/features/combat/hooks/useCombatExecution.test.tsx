// @vitest-environment jsdom

import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun, ExecutionController } from '@/features/task-execution'
import type { CopilotSetRunProjection } from '../model/copilotSetRun'
import { useCombatExecution } from './useCombatExecution'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const trackedRun = {
  runId: 'run-1',
  operationId: 'run_copilot_set',
  state: 'waiting',
  progress: {
    taskResults: [{ itemIndex: 0, stage: '1-7', status: 'success' }],
  },
} as unknown as AgentRun

const snapshot = {
  phase: 'live',
  identity: 'tracked',
  submission: 'idle',
  snapshot: null,
  trackedRunId: 'run-1',
  trackedScope: 'combat',
  trackedRun,
  lastError: null,
  lastSyncedAt: null,
  hasActiveRun: true,
  occupancy: null,
} as const

vi.mock('@/features/task-execution', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/task-execution')>()
  return {
    ...actual,
    useExecutionSnapshot: () => snapshot,
  }
})

const controller = {
  getState: () => snapshot,
} as unknown as ExecutionController

let root: Root
let container: HTMLDivElement
let rerender: (() => void) | null = null
const projections: Array<CopilotSetRunProjection | null> = []

function Harness() {
  const [, setTick] = useState(0)
  const execution = useCombatExecution({ notify: () => {}, controller })
  useEffect(() => {
    rerender = () => setTick(tick => tick + 1)
    projections.push(execution.setRun)
  })
  return null
}

describe('useCombatExecution run projection', () => {
  beforeEach(async () => {
    projections.length = 0
    rerender = null
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(<Harness />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('keeps the set-run projection stable across unrelated re-renders', async () => {
    const before = projections[projections.length - 1]
    expect(before).not.toBeNull()

    await act(async () => rerender?.())

    expect(projections[projections.length - 1]).toBe(before)
  })
})
