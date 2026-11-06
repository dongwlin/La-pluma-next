/**
 * MAA 自定义基建排班表（`resource/custom_infrast/*.json`）的浏览器侧模型。
 * 字段与语义以 MaaCore `InfrastTask::parse_and_set_custom_config` 和
 * `InfrastAbstractTask::check_room_shift_intent` 为准；未识别的字段一律原样保留。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const INFRASTRUCT_SCHEDULE_FACILITIES = [
  { key: 'control', label: '控制中枢' },
  { key: 'manufacture', label: '制造站' },
  { key: 'trading', label: '贸易站' },
  { key: 'power', label: '发电站' },
  { key: 'meeting', label: '会客室' },
  { key: 'hire', label: '办公室' },
  { key: 'dormitory', label: '宿舍' },
  { key: 'processing', label: '加工站' },
  { key: 'training', label: '训练室' },
  { key: 'recycle', label: '回收站' },
] as const

export type InfrastFacilityKey = (typeof INFRASTRUCT_SCHEDULE_FACILITIES)[number]['key']

export const INFRASTRUCT_MANUFACTURE_PRODUCTS = [
  'Battle Record',
  'Pure Gold',
  'Dualchip',
  'Originium Shard',
] as const

export const INFRASTRUCT_TRADING_PRODUCTS = ['LMD', 'Orundum'] as const

const ROOM_BOOLEAN_FIELDS = ['skip', 'autofill', 'sort', 'use_operator_groups'] as const
const ROOM_OPERATOR_FIELDS = ['operators', 'candidates', 'operatorsA', 'operatorsB'] as const

export type InfrastRoomOperatorField = (typeof ROOM_OPERATOR_FIELDS)[number]

export interface InfrastRoom {
  skip?: boolean
  autofill?: boolean
  sort?: boolean
  use_operator_groups?: boolean
  operators?: string[]
  candidates?: string[]
  operatorsA?: string[]
  operatorsB?: string[]
  product?: string
  [field: string]: unknown
}

export interface InfrastPlan {
  name?: string
  description?: string
  description_post?: string
  rooms: Record<string, InfrastRoom[]>
  [field: string]: unknown
}

export interface InfrastScheduleDocument {
  title?: string
  description?: string
  plans: InfrastPlan[]
  [field: string]: unknown
}

export interface InfrastScheduleSummary {
  name: string
  title: string | null
  planCount: number
  updatedAt: string | null
  valid: boolean
}

export interface InfrastScheduleListPayload {
  directory: string
  schedules: InfrastScheduleSummary[]
}

export interface InfrastScheduleDocumentPayload {
  name: string
  document: unknown
}

export type InfrastFacilityState = 'default' | 'keep' | 'rooms'
export type InfrastRoomState = 'shift' | 'keep' | 'skip'

export type InfrastScheduleParseResult =
  | { ok: true; document: InfrastScheduleDocument }
  | { ok: false; message: string }

const HOUR_MINUTE_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function validateOptionalString(value: unknown, label: string): string | null {
  return value === undefined || typeof value === 'string' ? null : `${label} 必须是字符串`
}

function validateOptionalBoolean(value: unknown, label: string): string | null {
  return value === undefined || typeof value === 'boolean' ? null : `${label} 必须是布尔值`
}

function validatePeriod(value: unknown, label: string): string | null {
  if (value === undefined) return null
  if (!Array.isArray(value) || !value.every(slot => (
    Array.isArray(slot)
    && slot.length === 2
    && slot.every(item => typeof item === 'string' && HOUR_MINUTE_PATTERN.test(item))
  ))) return `${label}.period 必须是 [["HH:mm", "HH:mm"]] 数组`
  return null
}

function validateFiammetta(value: unknown, label: string): string | null {
  if (value === undefined) return null
  if (!isRecord(value)) return `${label}.Fiammetta 必须是对象`
  const message = validateOptionalBoolean(value.enable, `${label}.Fiammetta.enable`)
    ?? validateOptionalString(value.target, `${label}.Fiammetta.target`)
  if (message) return message
  if (value.order !== undefined && value.order !== 'pre' && value.order !== 'post') {
    return `${label}.Fiammetta.order 只能是 pre 或 post`
  }
  return null
}

function validateDrones(value: unknown, label: string): string | null {
  if (value === undefined) return null
  if (!isRecord(value)) return `${label}.drones 必须是对象`
  if (value.enable !== undefined && typeof value.enable !== 'boolean') return `${label}.drones.enable 必须是布尔值`
  if (value.room !== undefined && value.room !== 'trading' && value.room !== 'manufacture') {
    return `${label}.drones.room 只能是 trading 或 manufacture`
  }
  if (value.index !== undefined && (!Number.isInteger(value.index) || (value.index as number) < 1 || (value.index as number) > 5)) {
    return `${label}.drones.index 必须是 1 至 5 的整数`
  }
  if (value.rule !== undefined && typeof value.rule !== 'string') return `${label}.drones.rule 必须是字符串`
  if (value.order !== undefined && value.order !== 'pre' && value.order !== 'post') {
    return `${label}.drones.order 只能是 pre 或 post`
  }
  return null
}

function validateGroups(value: unknown, label: string): string | null {
  if (value === undefined) return null
  if (!Array.isArray(value)) return `${label}.groups 必须是数组`
  for (const [index, group] of value.entries()) {
    if (!isRecord(group)) return `${label}.groups[${index}] 必须是对象`
    if (typeof group.name !== 'string') {
      return `${label}.groups[${index}].name 必须是字符串`
    }
    if (!isStringArray(group.operators)) return `${label}.groups[${index}].operators 必须是干员名数组`
  }
  return null
}

function validateRoom(value: unknown, label: string): string | null {
  if (!isRecord(value)) return `${label} 必须是对象`
  for (const field of ROOM_BOOLEAN_FIELDS) {
    const message = validateOptionalBoolean(value[field], `${label}.${field}`)
    if (message) return message
  }
  for (const field of ROOM_OPERATOR_FIELDS) {
    if (value[field] !== undefined && !isStringArray(value[field])) {
      return `${label}.${field} 必须是干员名字符串数组`
    }
  }
  return validateOptionalString(value.product, `${label}.product`)
}

function validateRooms(value: unknown, label: string): string | null {
  if (!isRecord(value)) return `${label}.rooms 必须是对象`
  for (const [facility, rooms] of Object.entries(value)) {
    const facilityLabel = `${label}.rooms.${facility}`
    if (!Array.isArray(rooms)) return `${facilityLabel} 必须是房间数组`
    for (const [index, room] of rooms.entries()) {
      const message = validateRoom(room, `${facilityLabel}[${index}]`)
      if (message) return message
    }
  }
  return null
}

function validatePlan(value: unknown, label: string): string | null {
  if (!isRecord(value)) return `${label} 必须是对象`
  const message = validateOptionalString(value.name, `${label}.name`)
    ?? validateOptionalString(value.description, `${label}.description`)
    ?? validateOptionalString(value.description_post, `${label}.description_post`)
    ?? validatePeriod(value.period, label)
    ?? validateFiammetta(value.Fiammetta, label)
    ?? validateDrones(value.drones, label)
    ?? validateGroups(value.groups, label)
  if (message) return message
  if (value.duration !== undefined && (typeof value.duration !== 'number' || !Number.isFinite(value.duration))) {
    return `${label}.duration 必须是有限数字`
  }
  return validateRooms(value.rooms, label)
}

/** 与 MaaCore 必读字段对齐的前置校验；通过后仍可能被 Core 忽略未知设施。 */
export function validateInfrastScheduleDocument(value: unknown): string | null {
  if (!isRecord(value)) return '排班表必须是 JSON 对象'
  const message = validateOptionalString(value.title, 'title') ?? validateOptionalString(value.description, 'description')
  if (message) return message
  if (!Array.isArray(value.plans)) return 'plans 必须是方案数组'
  if (value.plans.length === 0) return 'plans 至少包含一个方案'
  for (const [index, plan] of value.plans.entries()) {
    const planMessage = validatePlan(plan, `plans[${index}]`)
    if (planMessage) return planMessage
  }
  return null
}

export function parseInfrastScheduleDocument(value: unknown): InfrastScheduleParseResult {
  const message = validateInfrastScheduleDocument(value)
  return message ? { ok: false, message } : { ok: true, document: value as InfrastScheduleDocument }
}

export function readInfrastPlans(document: InfrastScheduleDocument | null | undefined): InfrastPlan[] {
  return Array.isArray(document?.plans) ? document.plans : []
}

export function getInfrastFacilityLabel(facility: string): string {
  return INFRASTRUCT_SCHEDULE_FACILITIES.find(item => item.key === facility)?.label ?? facility
}

export function getInfrastPlanLabel(plan: InfrastPlan | undefined, index: number): string {
  const name = typeof plan?.name === 'string' ? plan.name.trim() : ''
  return name || `方案 ${index + 1}`
}

export function getInfrastFacilityState(plan: InfrastPlan, facility: string): InfrastFacilityState {
  const rooms = plan.rooms[facility]
  if (!Array.isArray(rooms)) return 'default'
  return rooms.length === 0 ? 'keep' : 'rooms'
}

export function readInfrastFacilityRooms(plan: InfrastPlan, facility: string): InfrastRoom[] {
  const rooms = plan.rooms[facility]
  return Array.isArray(rooms) ? rooms : []
}

export function hasInfrastRoomIntent(room: InfrastRoom): boolean {
  if (room.autofill === true) return true
  return ROOM_OPERATOR_FIELDS.some(field => Array.isArray(room[field]) && (room[field] as unknown[]).length > 0)
}

export function getInfrastRoomState(room: InfrastRoom): InfrastRoomState {
  if (room.skip === true) return 'skip'
  return hasInfrastRoomIntent(room) ? 'shift' : 'keep'
}
