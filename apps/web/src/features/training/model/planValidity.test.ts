import { describe, expect, it } from 'vitest'
import {
  canApplyTrainingPlan,
  canGenerateTrainingPlan,
  captureTrainingPlanBasis,
  isTrainingPlanBasisCurrent,
} from './planValidity'

describe('training plan validity', () => {
  it('captures a stable basis from the queue revision and settings revision', () => {
    expect(captureTrainingPlanBasis('queue-1', 3)).toEqual({
      queueRevision: 'queue-1',
      settingsRevision: 3,
    })
    expect(captureTrainingPlanBasis(undefined, 0)).toEqual({
      queueRevision: null,
      settingsRevision: 0,
    })
  })

  it('keeps a plan current only while both queue and settings revisions match', () => {
    const basis = captureTrainingPlanBasis('queue-1', 2)

    expect(isTrainingPlanBasisCurrent(basis, { queueRevision: 'queue-1', settingsRevision: 2 }))
      .toBe(true)
    expect(isTrainingPlanBasisCurrent(basis, { queueRevision: 'queue-2', settingsRevision: 2 }))
      .toBe(false)
    expect(isTrainingPlanBasisCurrent(basis, { queueRevision: 'queue-1', settingsRevision: 3 }))
      .toBe(false)
  })

  it('does not generate without a queue or while the queue refresh failed', () => {
    expect(canGenerateTrainingPlan({ hasQueue: true, busy: false, refreshFailed: false }))
      .toBe(true)
    expect(canGenerateTrainingPlan({ hasQueue: false, busy: false, refreshFailed: false }))
      .toBe(false)
    expect(canGenerateTrainingPlan({ hasQueue: true, busy: true, refreshFailed: false }))
      .toBe(false)
    expect(canGenerateTrainingPlan({ hasQueue: true, busy: false, refreshFailed: true }))
      .toBe(false)
  })

  it('does not apply a plan once its basis changed or the queue refresh failed', () => {
    expect(canApplyTrainingPlan({
      hasPlan: true,
      busy: false,
      refreshFailed: false,
      basisCurrent: true,
    })).toBe(true)
    expect(canApplyTrainingPlan({
      hasPlan: true,
      busy: false,
      refreshFailed: false,
      basisCurrent: false,
    })).toBe(false)
    expect(canApplyTrainingPlan({
      hasPlan: true,
      busy: false,
      refreshFailed: true,
      basisCurrent: true,
    })).toBe(false)
    expect(canApplyTrainingPlan({
      hasPlan: false,
      busy: false,
      refreshFailed: false,
      basisCurrent: true,
    })).toBe(false)
  })
})
