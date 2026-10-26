import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RECRUITMENT_TIME,
  RECRUITMENT_TIME_MAX,
  RECRUITMENT_TIME_MIN,
  RECRUITMENT_TIME_STEP,
  normalizeRecruitmentTime,
} from './taskParamRules'

describe('taskParamRules', () => {
  it('publishes the 60–540 minute bounds in 10 minute steps', () => {
    expect(RECRUITMENT_TIME_MIN).toBe(60)
    expect(RECRUITMENT_TIME_MAX).toBe(540)
    expect(RECRUITMENT_TIME_STEP).toBe(10)
    expect(DEFAULT_RECRUITMENT_TIME).toBe(540)
  })

  it('rounds valid durations to the nearest ten minutes', () => {
    expect(normalizeRecruitmentTime('300')).toBe(300)
    expect(normalizeRecruitmentTime('304')).toBe(300)
    expect(normalizeRecruitmentTime('305')).toBe(310)
    expect(normalizeRecruitmentTime(487)).toBe(490)
  })

  it('clamps durations to the supported range', () => {
    expect(normalizeRecruitmentTime('0')).toBe(60)
    expect(normalizeRecruitmentTime('59')).toBe(60)
    expect(normalizeRecruitmentTime('541')).toBe(540)
    expect(normalizeRecruitmentTime('9999')).toBe(540)
  })

  it('falls back to the default for non-finite input while empty input reads as zero', () => {
    expect(normalizeRecruitmentTime('')).toBe(60)
    expect(normalizeRecruitmentTime(null)).toBe(60)
    expect(normalizeRecruitmentTime(undefined)).toBe(DEFAULT_RECRUITMENT_TIME)
    expect(normalizeRecruitmentTime('abc')).toBe(DEFAULT_RECRUITMENT_TIME)
    expect(normalizeRecruitmentTime(Number.POSITIVE_INFINITY)).toBe(DEFAULT_RECRUITMENT_TIME)
    expect(normalizeRecruitmentTime(Number.NaN)).toBe(DEFAULT_RECRUITMENT_TIME)
  })
})
