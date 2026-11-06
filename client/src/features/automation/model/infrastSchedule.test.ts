import { describe, expect, it } from 'vitest'
import {
  getInfrastFacilityState,
  getInfrastPlanLabel,
  getInfrastRoomState,
  INFRASTRUCT_MANUFACTURE_PRODUCTS,
  INFRASTRUCT_TRADING_PRODUCTS,
  parseInfrastScheduleDocument,
  readInfrastFacilityRooms,
  validateInfrastScheduleDocument,
  type InfrastPlan,
  type InfrastScheduleDocument,
} from './infrastSchedule'
import {
  addInfrastPlan,
  appendInfrastFacilityRoom,
  createEmptyInfrastScheduleDocument,
  formatInfrastOperatorText,
  normalizeInfrastPlanIndex,
  parseInfrastOperatorText,
  readInfrastScheduleTarget,
  removeInfrastFacilityRoom,
  removeInfrastPlan,
  setInfrastFacilityState,
  setInfrastRoomFlag,
  setInfrastRoomOperators,
  setInfrastRoomProduct,
  setInfrastRoomState,
  updateInfrastDocumentMeta,
  updateInfrastFacilityRoom,
  updateInfrastPlanAt,
  updateInfrastPlanMeta,
} from './infrastScheduleEditing'

const minimal = (): InfrastScheduleDocument => ({ plans: [{ rooms: {} }] })

describe('custom infrastructure schedule document validation', () => {
  it('accepts MAA-bundled legacy quirks that Core tolerates', () => {
    expect(validateInfrastScheduleDocument({
      plans: [{
        rooms: {},
        period: [['5:00', '20:59']],
        drones: { room: 'manufacture', index: '3', enable: true },
      }],
    })).toBeNull()
    expect(validateInfrastScheduleDocument({
      plans: [{ rooms: {}, drones: { index: '6' } }],
    })).toBe('plans[0].drones.index 必须是 1 至 5 的整数或数字字符串')
  })

  it('offers only the documented Core products for manufacture and trading', () => {
    expect([...INFRASTRUCT_MANUFACTURE_PRODUCTS])
      .toEqual(['Battle Record', 'Pure Gold', 'Dualchip', 'Originium Shard'])
    expect([...INFRASTRUCT_TRADING_PRODUCTS]).toEqual(['LMD', 'Orundum'])
  })

  it('accepts the minimal Core configuration without adding fields', () => {
    const document = minimal()
    expect(validateInfrastScheduleDocument(document)).toBeNull()
    expect(parseInfrastScheduleDocument(document)).toEqual({ ok: true, document })
    expect(document).toEqual({ plans: [{ rooms: {} }] })
  })

  it('accepts a user schedule with extension fields and every documented room kind', () => {
    const document = {
      author: 'uye',
      id: 1730652690046966,
      title: '153 极限效率',
      description: '说明',
      planTimes: '3班',
      layout: [{ type: 'trading', level: 3 }],
      metadata: { version: 1 },
      plans: [{
        name: 'A+B 16H',
        description_post: '16 小时后换班',
        period: [['22:00', '23:59'], ['00:00', '06:00']],
        duration: 960,
        Fiammetta: { enable: true, target: '但书', order: 'pre' },
        drones: { room: 'manufacture', index: 1, enable: true, order: 'pre' },
        groups: [{ name: '古+银', operators: ['古米', '银灰', '梅'] }],
        rooms: {
          control: [{ operators: ['夕', '令'] }],
          manufacture: [{ skip: false, product: 'Pure Gold', operators: ['苍苔', '砾'], sort: true, autofill: false }],
          trading: [{ product: 'LMD', operators: ['伺夜', '黑键'] }],
          power: [{ operators: ['承曦格雷伊'] }],
          meeting: [{ autofill: true }],
          hire: [{ operators: ['菲亚梅塔'] }],
          dormitory: [{ operators: ['杜宾'], candidates: ['卡缇'] }],
          processing: [{ skip: true }],
          training: [{ operatorsA: ['杜宾'], operatorsB: ['银灰'] }],
          recycle: [{ operators: ['芬', '克洛丝'] }],
          future_room: [{ operators: ['任意'] }],
        },
      }],
    }
    expect(validateInfrastScheduleDocument(document)).toBeNull()
  })

  it('rejects structurally invalid documents with actionable messages', () => {
    expect(validateInfrastScheduleDocument(null)).toBe('排班表必须是 JSON 对象')
    expect(validateInfrastScheduleDocument({ plans: [] })).toBe('plans 至少包含一个方案')
    expect(validateInfrastScheduleDocument({ plans: [{ name: '无房间' }] }))
      .toBe('plans[0].rooms 必须是对象')
    expect(validateInfrastScheduleDocument({ plans: [{ rooms: { manufacture: {} } }] }))
      .toBe('plans[0].rooms.manufacture 必须是房间数组')
    expect(validateInfrastScheduleDocument({ plans: [{ rooms: { manufacture: [{ skip: '1' }] } }] }))
      .toBe('plans[0].rooms.manufacture[0].skip 必须是布尔值')
    expect(validateInfrastScheduleDocument({ plans: [{ rooms: { dormitory: [{ operators: '银灰' }] } }] }))
      .toBe('plans[0].rooms.dormitory[0].operators 必须是干员名字符串数组')
    expect(validateInfrastScheduleDocument({ plans: [{ rooms: { manufacture: [{ product: 1 }] } }] }))
      .toBe('plans[0].rooms.manufacture[0].product 必须是字符串')
    expect(validateInfrastScheduleDocument({ plans: [{ rooms: { manufacture: [{ product: 'Future Product' }] } }] }))
      .toBeNull()
    expect(validateInfrastScheduleDocument({ plans: [{ rooms: {}, groups: [{ operators: [] }] }] }))
      .toBe('plans[0].groups[0].name 必须是字符串')
    expect(validateInfrastScheduleDocument({ plans: [{ rooms: {}, period: [['5:00', 6]] }] }))
      .toBe('plans[0].period 必须是 [[开始时间, 结束时间]] 两元素字符串数组')
  })
})

describe('room and facility states match MaaCore intent detection', () => {
  it('distinguishes default, whole-facility keep and configured rooms', () => {
    const plan: InfrastPlan = {
      rooms: {
        manufacture: [{ operators: ['芬'] }],
        trading: [],
        power: [{ skip: true }],
      },
    }
    expect(getInfrastFacilityState(plan, 'manufacture')).toBe('rooms')
    expect(getInfrastFacilityState(plan, 'trading')).toBe('keep')
    expect(getInfrastFacilityState(plan, 'dormitory')).toBe('default')
    expect(getInfrastFacilityState(plan, 'power')).toBe('rooms')
  })

  it('treats skip, explicit operator intent and empty intent as three distinct room states', () => {
    expect(getInfrastRoomState({}, 'manufacture')).toBe('keep')
    expect(getInfrastRoomState({ skip: false }, 'manufacture')).toBe('keep')
    expect(getInfrastRoomState({ use_operator_groups: true }, 'manufacture')).toBe('keep')
    expect(getInfrastRoomState({ operators: [] }, 'manufacture')).toBe('keep')
    expect(getInfrastRoomState({ candidates: ['银灰'] }, 'manufacture')).toBe('shift')
    expect(getInfrastRoomState({ autofill: true }, 'manufacture')).toBe('shift')
    expect(getInfrastRoomState({ operatorsA: ['杜宾'] }, 'training')).toBe('shift')
    expect(getInfrastRoomState({ operatorsB: ['银灰'] }, 'training')).toBe('shift')
    expect(getInfrastRoomState({ operatorsA: ['杜宾'] }, 'manufacture')).toBe('keep')
    expect(getInfrastRoomState({ skip: true, operators: ['银灰'] }, 'manufacture')).toBe('skip')
  })

  it('serializes states without writing defaults for keep or shift', () => {
    expect(setInfrastRoomState({ product: 'LMD' }, 'keep')).toEqual({ product: 'LMD' })
    expect(setInfrastRoomState({ skip: true, product: 'LMD' }, 'keep')).toEqual({ product: 'LMD' })
    expect(setInfrastRoomState({ skip: true, product: 'LMD' }, 'shift')).toEqual({ product: 'LMD' })
    expect(setInfrastRoomState({ operators: ['银灰'] }, 'skip')).toEqual({ operators: ['银灰'], skip: true })
    expect(setInfrastRoomState({ skip: true, operators: ['银灰'] }, 'skip')).toEqual({ operators: ['银灰'], skip: true })
  })

  it('drops intent fields only when the user explicitly keeps a room', () => {
    const room = {
      operators: ['银灰'],
      candidates: ['夜刀'],
      operatorsA: ['杜宾'],
      autofill: true,
      use_operator_groups: true,
      sort: true,
      product: 'LMD',
      custom_field: '保留',
    }
    expect(setInfrastRoomState(room, 'keep')).toEqual({
      sort: true,
      product: 'LMD',
      custom_field: '保留',
    })
  })
})

describe('edits preserve untouched rooms and unknown fields', () => {
  it('updates one room without changing sibling rooms or extension fields', () => {
    const plan: InfrastPlan = {
      name: '方案',
      custom_plan_field: { keep: true },
      rooms: {
        manufacture: [
          { operators: ['芬'], custom_room: 'a' },
          { skip: true },
        ],
        trading: [{ product: 'LMD', operators: ['伺夜'] }],
      },
    }
    const original = JSON.parse(JSON.stringify(plan)) as InfrastPlan
    const firstRoom = plan.rooms.manufacture?.[0] ?? {}
    const updated = updateInfrastFacilityRoom(
      plan,
      'manufacture',
      0,
      setInfrastRoomOperators({ ...firstRoom, custom_room: 'a' }, 'operators', ['克洛丝']),
    )

    expect(updated.rooms.trading).toEqual(original.rooms.trading)
    expect(updated.rooms.manufacture?.[1]).toEqual(original.rooms.manufacture?.[1])
    expect(updated.custom_plan_field).toEqual({ keep: true })
    expect(updated.rooms.manufacture?.[0]).toEqual({ operators: ['克洛丝'], custom_room: 'a' })
  })

  it('keeps unknown plan and document fields through plan edits', () => {
    const document: InfrastScheduleDocument = {
      author: 'lhh',
      plans: [{ name: '早班', unknown_plan_field: 1, rooms: { power: [{ operators: ['承曦格雷伊'] }] } }],
    }
    const firstPlan = document.plans[0]
    if (!firstPlan) throw new Error('missing plan')
    const plan = updateInfrastPlanMeta(firstPlan, { name: '晚班', description: '说明' })
    const updated = updateInfrastPlanAt(document, 0, plan)

    expect(updated.author).toBe('lhh')
    expect(updated.plans[0]).toEqual({
      unknown_plan_field: 1,
      name: '晚班',
      description: '说明',
      rooms: { power: [{ operators: ['承曦格雷伊'] }] },
    })
  })

  it('keeps explicit facility keep and removes the key only when reset to default', () => {
    const plan: InfrastPlan = { rooms: { dormitory: [] } }
    expect(setInfrastFacilityState(plan, 'dormitory', 'default')).toEqual({ rooms: {} })
    expect(setInfrastFacilityState(plan, 'dormitory', 'rooms')).toEqual({ rooms: { dormitory: [{}] } })
    expect(setInfrastFacilityState(plan, 'manufacture', 'keep')).toEqual({ rooms: { dormitory: [], manufacture: [] } })
  })

  it('keeps the facility explicitly empty after the last configured room is removed', () => {
    const plan: InfrastPlan = { rooms: { trading: [{ operators: ['伺夜'] }] } }
    expect(removeInfrastFacilityRoom(plan, 'trading', 0)).toEqual({ rooms: { trading: [] } })
    expect(appendInfrastFacilityRoom({ rooms: {} }, 'trading')).toEqual({ rooms: { trading: [{}] } })
    expect(readInfrastFacilityRooms(plan, 'trading')).toHaveLength(1)
    expect(readInfrastFacilityRooms(plan, 'missing')).toEqual([])
  })

  it('edits only the requested operator field and removes empty lists', () => {
    const room = { operators: ['芬'], custom: 1 }
    expect(setInfrastRoomOperators(room, 'operators', ['黑角', '卡缇']))
      .toEqual({ operators: ['黑角', '卡缇'], custom: 1 })
    expect(setInfrastRoomOperators(room, 'operators', [])).toEqual({ custom: 1 })
    expect(setInfrastRoomOperators(room, 'candidates', ['  ', '夜刀'])).toEqual({ operators: ['芬'], candidates: ['夜刀'], custom: 1 })
    expect(setInfrastRoomFlag(room, 'autofill', true)).toEqual({ operators: ['芬'], custom: 1, autofill: true })
    expect(setInfrastRoomFlag({ ...room, skip: true }, 'skip', false)).toEqual({ operators: ['芬'], custom: 1 })
    expect(setInfrastRoomProduct(room, 'LMD')).toEqual({ operators: ['芬'], custom: 1, product: 'LMD' })
    expect(setInfrastRoomProduct({ ...room, product: 'LMD' }, '')).toEqual({ operators: ['芬'], custom: 1 })
  })

  it('parses operator text without reordering or keeping duplicates', () => {
    expect(parseInfrastOperatorText('芬, 克洛丝，夜刀\n芬')).toEqual(['芬', '克洛丝', '夜刀'])
    expect(parseInfrastOperatorText('')).toEqual([])
    expect(formatInfrastOperatorText(['芬', '克洛丝'])).toBe('芬, 克洛丝')
    expect(formatInfrastOperatorText(undefined)).toBe('')
  })
})

describe('plans, metadata and task parameter migration', () => {
  it('adds and removes plans while keeping at least one plan', () => {
    const added = addInfrastPlan(minimal())
    expect(added.index).toBe(1)
    expect(added.document.plans).toHaveLength(2)
    expect(getInfrastPlanLabel(added.document.plans[0], 0)).toBe('方案 1')
    expect(getInfrastPlanLabel({ ...(added.document.plans[1] ?? { rooms: {} }), name: '晚班' }, 1)).toBe('晚班')

    const kept = removeInfrastPlan(minimal(), 0)
    expect(kept.document.plans).toHaveLength(1)
    expect(removeInfrastPlan(added.document, 0).index).toBe(0)
    expect(removeInfrastPlan(added.document, 1).document.plans).toHaveLength(1)
  })

  it('updates document metadata and drops emptied optional fields', () => {
    const document = { ...minimal(), title: '旧标题', description: '旧说明', extra: true }
    expect(updateInfrastDocumentMeta(document, { title: '新标题' })).toEqual({
      plans: [{ rooms: {} }], title: '新标题', description: '旧说明', extra: true,
    })
    expect(updateInfrastDocumentMeta(document, { description: '' })).toEqual({
      plans: [{ rooms: {} }], title: '旧标题', extra: true,
    })
  })

  it('normalizes plan indexes from legacy string parameters', () => {
    expect(normalizeInfrastPlanIndex(undefined)).toBe(0)
    expect(normalizeInfrastPlanIndex('2')).toBe(2)
    expect(normalizeInfrastPlanIndex('')).toBe(0)
    expect(normalizeInfrastPlanIndex(-1)).toBe(0)
    expect(normalizeInfrastPlanIndex(1.5)).toBe(0)
    expect(normalizeInfrastPlanIndex(4, 3)).toBe(2)
    expect(normalizeInfrastPlanIndex(4)).toBe(4)
  })

  it('reads old task parameters without inventing a schedule document', () => {
    expect(readInfrastScheduleTarget({ filename: ' schedules/base.json ', plan_index: '1' }))
      .toEqual({ filename: 'schedules/base.json', planIndex: 1 })
    expect(readInfrastScheduleTarget({ plan_index: 'x' })).toEqual({ filename: '', planIndex: 0 })
    expect(readInfrastScheduleTarget(null)).toEqual({ filename: '', planIndex: 0 })
  })

  it('creates a minimal editable document only on explicit request', () => {
    expect(createEmptyInfrastScheduleDocument()).toEqual({ plans: [{ name: '方案 1', rooms: {} }] })
    expect(minimal()).toEqual({ plans: [{ rooms: {} }] })
  })
})
