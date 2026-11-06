import {
  getInfrastFacilityState,
  readInfrastFacilityRooms,
  type InfrastPlan,
  type InfrastRoom,
  type InfrastRoomOperatorField,
  type InfrastRoomState,
  type InfrastScheduleDocument,
  type InfrastFacilityState,
} from './infrastSchedule'

/**
 * 排班表的编辑操作：只改写用户触碰到的房间/字段，未编辑的房间和
 * 未识别的扩展字段保持原引用内容，避免把“保持原样”写成了默认值。
 */

const OPERATOR_FIELDS = ['operators', 'candidates', 'operatorsA', 'operatorsB'] as const

export function setInfrastFacilityState(
  plan: InfrastPlan,
  facility: string,
  state: InfrastFacilityState,
): InfrastPlan {
  const rooms = { ...plan.rooms }
  if (state === 'default') {
    delete rooms[facility]
  } else if (state === 'keep') {
    rooms[facility] = []
  } else if (getInfrastFacilityState(plan, facility) !== 'rooms') {
    rooms[facility] = [{}]
  }
  return { ...plan, rooms }
}

export function updateInfrastFacilityRoom(
  plan: InfrastPlan,
  facility: string,
  index: number,
  room: InfrastRoom,
): InfrastPlan {
  const rooms = readInfrastFacilityRooms(plan, facility).slice()
  if (index < 0 || index >= rooms.length) return plan
  rooms[index] = room
  return { ...plan, rooms: { ...plan.rooms, [facility]: rooms } }
}

export function appendInfrastFacilityRoom(plan: InfrastPlan, facility: string): InfrastPlan {
  const rooms = [...readInfrastFacilityRooms(plan, facility), {}]
  return { ...plan, rooms: { ...plan.rooms, [facility]: rooms } }
}

export function removeInfrastFacilityRoom(plan: InfrastPlan, facility: string, index: number): InfrastPlan {
  const rooms = readInfrastFacilityRooms(plan, facility).filter((_, current) => current !== index)
  const nextRooms = { ...plan.rooms }
  if (rooms.length === 0) delete nextRooms[facility]
  else nextRooms[facility] = rooms
  return { ...plan, rooms: nextRooms }
}

export function setInfrastRoomState(room: InfrastRoom, state: InfrastRoomState): InfrastRoom {
  if (state === 'skip') return { ...room, skip: true }
  const next = { ...room }
  delete next.skip
  if (state === 'keep') {
    delete next.autofill
    delete next.use_operator_groups
    for (const field of OPERATOR_FIELDS) delete next[field]
  }
  return next
}

function dedupeNames(names: readonly string[]): string[] {
  const result: string[] = []
  for (const name of names) {
    const trimmed = name.trim()
    if (trimmed && !result.includes(trimmed)) result.push(trimmed)
  }
  return result
}

export function parseInfrastOperatorText(text: string): string[] {
  return dedupeNames(text.split(/[,，\n]/))
}

export function formatInfrastOperatorText(names: readonly string[] | undefined): string {
  return Array.isArray(names) ? names.join(', ') : ''
}

export function setInfrastRoomOperators(
  room: InfrastRoom,
  field: InfrastRoomOperatorField,
  names: readonly string[],
): InfrastRoom {
  const next = { ...room }
  const cleaned = dedupeNames(names)
  if (cleaned.length === 0) delete next[field]
  else next[field] = cleaned
  return next
}

export function setInfrastRoomFlag(
  room: InfrastRoom,
  field: 'skip' | 'autofill' | 'sort' | 'use_operator_groups',
  value: boolean,
): InfrastRoom {
  const next = { ...room }
  if (value) next[field] = true
  else delete next[field]
  return next
}

export function setInfrastRoomProduct(room: InfrastRoom, product: string): InfrastRoom {
  const next = { ...room }
  if (product) next.product = product
  else delete next.product
  return next
}

export function updateInfrastPlanMeta(
  plan: InfrastPlan,
  patch: { name?: string; description?: string; description_post?: string },
): InfrastPlan {
  const next = { ...plan }
  for (const field of ['name', 'description', 'description_post'] as const) {
    const value = patch[field]
    if (value === undefined) continue
    if (value.trim()) next[field] = value
    else delete next[field]
  }
  return { ...next, rooms: plan.rooms }
}

export function updateInfrastPlanAt(
  document: InfrastScheduleDocument,
  index: number,
  plan: InfrastPlan,
): InfrastScheduleDocument {
  return {
    ...document,
    plans: document.plans.map((current, currentIndex) => currentIndex === index ? plan : current),
  }
}

export function addInfrastPlan(document: InfrastScheduleDocument): {
  document: InfrastScheduleDocument
  index: number
} {
  const plans = [...document.plans, { rooms: {} }]
  return { document: { ...document, plans }, index: plans.length - 1 }
}

export function removeInfrastPlan(
  document: InfrastScheduleDocument,
  index: number,
): { document: InfrastScheduleDocument; index: number } {
  if (document.plans.length <= 1) return { document, index: 0 }
  const plans = document.plans.filter((_, current) => current !== index)
  return { document: { ...document, plans }, index: Math.max(0, Math.min(index, plans.length - 1)) }
}

export function updateInfrastDocumentMeta(
  document: InfrastScheduleDocument,
  patch: { title?: string; description?: string },
): InfrastScheduleDocument {
  const next = { ...document }
  for (const field of ['title', 'description'] as const) {
    const value = patch[field]
    if (value === undefined) continue
    if (value.trim()) next[field] = value
    else delete next[field]
  }
  return next
}

export function createEmptyInfrastScheduleDocument(): InfrastScheduleDocument {
  return { plans: [{ name: '方案 1', rooms: {} }] }
}

export function normalizeInfrastPlanIndex(value: unknown, planCount?: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  let index = Number.isInteger(parsed) && parsed > 0 ? parsed : 0
  if (planCount !== undefined && planCount > 0) index = Math.min(index, planCount - 1)
  return index
}

export interface InfrastScheduleTarget {
  filename: string
  planIndex: number
}

export function readInfrastScheduleTarget(
  params: Record<string, unknown> | null | undefined,
): InfrastScheduleTarget {
  return {
    filename: typeof params?.filename === 'string' ? params.filename.trim() : '',
    planIndex: normalizeInfrastPlanIndex(params?.plan_index),
  }
}

export function normalizeInfrastTaskParams<T extends Record<string, unknown>>(params: T): T {
  const target = readInfrastScheduleTarget(params)
  return { ...params, filename: target.filename, plan_index: target.planIndex }
}
