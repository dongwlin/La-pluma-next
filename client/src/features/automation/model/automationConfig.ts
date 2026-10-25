/**
 * 自动化配置持久化适配器
 *
 * 把 task flow 与 schedule 的本地布局、服务端 wire 形状、加载迁移与完整提交条件
 * 集中到域内，页面只通过 user-config 协调器读写。配置 key、本地键、pending 键与
 * “编辑即入队”的提交时机都沿用迁移前的实现，因此旧版本的本地草稿与服务端配置
 * 无需迁移即可继续读取。
 *
 * 关键边界：
 * - task flow 的 `icon`、`paramFields` 属于界面派生字段，不进入草稿或 wire；
 * - schedule 的禁用项只保留在本地 `maa-schedule.entries`，wire 只发送启用时间点；
 * - 完整提交 = `saveUserConfig` 成功 + `setupSchedule`/`stopSchedule` 成功，
 *   只有两部分都完成才允许协调器确认 pending；
 * - 加载同时接受旧 `times` 与新 `entries`，并把任务参数迁移到当前默认形状。
 */

import { getErrorMessage } from '@/shared/api'
import {
  USER_CONFIG_KEYS,
  USER_CONFIG_PENDING_KEYS,
  loadUserConfig,
  saveUserConfig,
  type ConfigCommitResult,
  type ConfigLoadResult,
  type ConfigPersistenceAdapter,
} from '@/features/user-config'
import { setupSchedule, stopSchedule } from '../api'
import type { TaskFlowItem } from '../types'

/** 服务端配置 key，与迁移前一致。 */
export const AUTOMATION_CONFIG_KEY = USER_CONFIG_KEYS.automationTasks
/** 本设备未同步草稿标记，成功提交后由协调器删除。 */
export const AUTOMATION_CONFIG_PENDING_KEY = USER_CONFIG_PENDING_KEYS[USER_CONFIG_KEYS.automationTasks]
/** 本地草稿键，保持迁移前的键名与布局。 */
export const AUTOMATION_TASK_FLOW_KEY = 'maa-task-flow'
export const AUTOMATION_SCHEDULE_KEY = 'maa-schedule'
/** 与迁移前一致：每次编辑立即入队，不做去抖。 */
export const AUTOMATION_CONFIG_COMMIT_DELAY_MS = 0

const FALLBACK_ERROR_MESSAGE = '暂时无法连接服务器'
const scheduleTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/

export interface ScheduleTimeEntry {
  time: string
  enabled: boolean
}

export interface AutomationScheduleDraft {
  enabled: boolean
  /** 本地启用/禁用项；wire 只发送 `enabled` 项的时间。 */
  entries: ScheduleTimeEntry[]
}

/** task flow 的持久化形状：不含 `icon`/`paramFields` 等界面派生字段。 */
export type AutomationTaskFlowItem = Omit<TaskFlowItem, 'icon' | 'paramFields'>

export interface AutomationConfigDraft {
  taskFlow: AutomationTaskFlowItem[]
  schedule: AutomationScheduleDraft
}

export interface AutomationConfigWire {
  taskFlow: AutomationTaskFlowItem[]
  schedule: { enabled: boolean; times: string[] }
}

const DEFAULT_SCHEDULE_TIMES = ['08:00', '14:00', '20:00'] as const

/** 默认执行时间；每次返回新对象，避免草稿之间共享可变的条目。 */
export function createDefaultScheduleEntries(): ScheduleTimeEntry[] {
  return DEFAULT_SCHEDULE_TIMES.map(time => ({ time, enabled: true }))
}

/** 默认草稿与迁移前页面初始 state 对齐，供加载完成前渲染与缺失字段回填。 */
export function createDefaultAutomationDraft(): AutomationConfigDraft {
  return { taskFlow: [], schedule: { enabled: false, entries: createDefaultScheduleEntries() } }
}

export function normalizeScheduleTimes(times: string[]): string[] {
  return [...new Set(times.filter(time => scheduleTimePattern.test(time)))]
}

export function formatScheduleTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function parseScheduleTime(time: string): { hour: number; minute: number } {
  const [hourText = '0', minuteText = '0'] = time.split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)
  return {
    hour: Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 0,
    minute: Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 0,
  }
}

/** 去掉非法时间与重复项；`enabled` 缺省视为启用，与迁移前一致。 */
export function normalizeScheduleEntries(entries: ScheduleTimeEntry[]): ScheduleTimeEntry[] {
  const normalized: ScheduleTimeEntry[] = []
  const seen = new Set<string>()

  for (const entry of entries) {
    if (!scheduleTimePattern.test(entry.time) || seen.has(entry.time)) continue
    seen.add(entry.time)
    normalized.push({ time: entry.time, enabled: entry.enabled !== false })
  }

  return normalized
}

export function scheduleEntriesFromTimes(times: string[]): ScheduleTimeEntry[] {
  return normalizeScheduleEntries(
    normalizeScheduleTimes(times).map(time => ({ time, enabled: true })),
  )
}

/** wire 与 setupSchedule 使用的时间点：只包含启用项。 */
export function activeScheduleTimes(entries: ScheduleTimeEntry[]): string[] {
  return entries.filter(entry => entry.enabled).map(entry => entry.time)
}

/**
 * 采用服务端 schedule 时保留本设备独有的禁用时间点。
 *
 * 禁用项按设计不进入 wire（`times` 只含启用项），因此服务端副本无法表达它们。
 * 外部写入后强制重读时，若直接用服务端结果覆盖本地草稿，用户在本设备上编辑或
 * 禁用的时间点会被静默丢弃。合并规则：
 * - 服务端已启用的时间点优先（时间点不能同时启用与禁用）；
 * - 本地禁用且服务端没有的时间点保留，并尽量保持本地顺序；
 * - 其余按服务端顺序补入。
 */
export function mergeLocalScheduleEntries(
  serverEntries: ScheduleTimeEntry[],
  localEntries: ScheduleTimeEntry[],
): ScheduleTimeEntry[] {
  const serverTimes = new Set(serverEntries.map(entry => entry.time))
  const merged: ScheduleTimeEntry[] = []
  const seen = new Set<string>()

  for (const entry of localEntries) {
    if (seen.has(entry.time)) continue
    if (!entry.enabled) {
      if (!serverTimes.has(entry.time)) {
        seen.add(entry.time)
        merged.push({ ...entry })
      }
      continue
    }
    if (serverTimes.has(entry.time)) {
      seen.add(entry.time)
      merged.push({ time: entry.time, enabled: true })
    }
  }

  for (const entry of serverEntries) {
    if (seen.has(entry.time)) continue
    seen.add(entry.time)
    merged.push({ ...entry })
  }

  return merged
}

/**
 * 读取 schedule 的 `entries`/`times` 混合形状。
 * `entries` 优先（保留禁用项），为空时回退到旧 `times`（全部启用）。
 */
export function readScheduleEntries(
  schedule: { times?: unknown; entries?: unknown } | null | undefined,
): ScheduleTimeEntry[] {
  if (Array.isArray(schedule?.entries)) {
    const fromEntries = normalizeScheduleEntries(
      schedule.entries
        .map((entry: unknown) => {
          if (typeof entry === 'string') return { time: entry, enabled: true }
          if (!isRecord(entry)) return null
          if (typeof entry.time !== 'string') return null
          return { time: entry.time, enabled: entry.enabled !== false }
        })
        .filter((entry): entry is ScheduleTimeEntry => Boolean(entry)),
    )
    if (fromEntries.length > 0) return fromEntries
  }

  if (Array.isArray(schedule?.times)) {
    return scheduleEntriesFromTimes(
      schedule.times.filter((time): time is string => typeof time === 'string'),
    )
  }

  return []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 旧任务参数迁移，与迁移前页面加载路径一致：
 * - startup/closedown 删除已废弃的连接参数；
 * - fight/closedown/recruit/infrast/mall 补齐新字段并处理旧 `skip_robot`。
 */
export function migrateTaskParams<T extends Record<string, unknown>>(task: T): T {
  const commandId = typeof task.commandId === 'string'
    ? task.commandId
    : String(task.id || '').split('-')[0]
  if (!isRecord(task.params)) return task

  const params: Record<string, unknown> = { ...task.params }
  if (commandId === 'startup' || commandId === 'closedown') {
    delete params.adbPath
    delete params.address
  }
  if (commandId === 'fight') {
    params.drops ??= ''
    params.clientType ??= ''
    params.DrGrandet ??= false
    params.report_to_penguin ??= false
    params.penguin_id ??= ''
    params.report_to_yituliu ??= false
    params.yituliu_id ??= ''
  } else if (commandId === 'closedown') {
    params.recognizeDepotBeforeClose ??= true
  } else if (commandId === 'recruit') {
    if (params.preserve_tags === undefined && params.skip_robot === true) {
      params.preserve_tags = '支援机械'
    }
    params.force_refresh ??= true
    params.first_tags ??= ''
    params.extra_tags_mode ??= 0
    params.recruitment_time ??= { '3': 540, '4': 540 }
    delete params.skip_robot
  } else if (commandId === 'infrast') {
    params.filename ??= ''
    params.plan_index ??= 0
    params.continue_training ??= false
    params.dorm_notstationed_enabled ??= false
    params.dorm_trust_enabled ??= false
    params.reception_message_board ??= true
    params.reception_clue_exchange ??= true
    params.reception_send_clue ??= true
  } else if (commandId === 'mall') {
    params.visit_friends ??= true
    params.shopping ??= true
    params.buy_first ??= ''
    params.blacklist ??= ''
    params.force_shopping_if_credit_full ??= false
    params.only_buy_discount ??= false
    params.reserve_max_credit ??= false
    params.credit_fight ??= false
    params.formation_index ??= 0
  }
  return { ...task, params }
}

/** 关闭游戏步骤沿用启动游戏步骤的客户端类型，与迁移前加载路径一致。 */
export function synchronizeConnectionParams<T extends Record<string, unknown>>(tasks: T[]): T[] {
  const startupTask = tasks.find(task => (
    (typeof task.commandId === 'string' ? task.commandId : String(task.id || '').split('-')[0]) === 'startup'
  ))
  const startupParams = startupTask && isRecord(startupTask.params) ? startupTask.params : null
  if (!startupParams) return tasks

  return tasks.map(task => {
    const commandId = typeof task.commandId === 'string'
      ? task.commandId
      : String(task.id || '').split('-')[0]
    if (commandId !== 'closedown') return task
    const currentParams = isRecord(task.params) ? task.params : {}
    return {
      ...task,
      params: {
        ...currentParams,
        clientType: startupParams.clientType || currentParams.clientType || 'Official',
      },
    }
  })
}

/** 关闭游戏步骤始终排在流程最后。 */
export function placeClosedownLast<T extends { id: string; commandId?: string }>(tasks: T[]): T[] {
  return [
    ...tasks.filter(task => task.commandId !== 'closedown' && !task.id.startsWith('closedown-')),
    ...tasks.filter(task => task.commandId === 'closedown' || task.id.startsWith('closedown-')),
  ]
}

function stripTaskFlowUiFields(task: TaskFlowItem | AutomationTaskFlowItem): AutomationTaskFlowItem {
  const { icon: _icon, paramFields: _paramFields, ...rest } = task as TaskFlowItem
  return rest
}

/** 页面把编辑后的展示任务写回草稿时使用；界面字段不进入持久化载荷。 */
export function toPersistedTaskFlowItem(task: TaskFlowItem | AutomationTaskFlowItem): AutomationTaskFlowItem {
  return stripTaskFlowUiFields(task)
}

export function toPersistedTaskFlow(
  flow: Array<TaskFlowItem | AutomationTaskFlowItem>,
): AutomationTaskFlowItem[] {
  return flow.map(toPersistedTaskFlowItem)
}

function parseTaskFlow(value: unknown): AutomationTaskFlowItem[] | null {
  if (!Array.isArray(value)) return null

  const tasks: AutomationTaskFlowItem[] = []
  for (const item of value) {
    if (!isRecord(item)) return null
    if (typeof item.id !== 'string' || item.id.length === 0) return null
    if (item.params !== undefined && !isRecord(item.params)) return null
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') return null
    if (item.name !== undefined && typeof item.name !== 'string') return null
    if (item.description !== undefined && typeof item.description !== 'string') return null
    if (item.commandId !== undefined && typeof item.commandId !== 'string') return null
    if (item.taskType !== undefined && typeof item.taskType !== 'string') return null
    if (item.defaultParams !== undefined && !isRecord(item.defaultParams)) return null

    const { icon: _icon, paramFields: _paramFields, ...rest } = item
    tasks.push(migrateTaskParams(rest) as AutomationTaskFlowItem)
  }

  return placeClosedownLast(synchronizeConnectionParams(tasks))
}

function parseSchedule(value: unknown): AutomationScheduleDraft | null {
  if (!isRecord(value)) return null

  const enabled = value.enabled === undefined ? false : value.enabled
  if (typeof enabled !== 'boolean') return null

  if (value.entries !== undefined) {
    if (!Array.isArray(value.entries)) return null
    const entries = readScheduleEntries({ entries: value.entries })
    if (entries.length > 0) return { enabled, entries }
  }

  if (value.times !== undefined) {
    if (!Array.isArray(value.times)) return null
    const fromTimes = scheduleEntriesFromTimes(
      value.times.filter((time): time is string => typeof time === 'string'),
    )
    return {
      enabled,
      // 空数组在迁移前不会覆盖页面默认行，因此草稿同样保留默认时间点。
      entries: fromTimes.length > 0 ? fromTimes : createDefaultScheduleEntries(),
    }
  }

  // 没有可用时间点时保留默认条目，与迁移前“空数组不覆盖默认行”的表现一致。
  return { enabled, entries: createDefaultScheduleEntries() }
}

/**
 * 服务端载荷解码。缺失字段按默认草稿补齐；已知字段形状不合法时整份载荷不可用，
 * 协调器会回退本地草稿。
 */
function decodeAutomationConfig(payload: unknown): AutomationConfigDraft | null {
  if (!isRecord(payload)) return null
  const defaults = createDefaultAutomationDraft()

  const taskFlow = payload.taskFlow === undefined ? defaults.taskFlow : parseTaskFlow(payload.taskFlow)
  const schedule = payload.schedule === undefined ? defaults.schedule : parseSchedule(payload.schedule)
  if (taskFlow === null || schedule === null) return null

  // 禁用时间点只存在于本设备；采用服务端副本时保留，避免外部写入后的重读静默丢失。
  const localSchedule = readLocalSection(AUTOMATION_SCHEDULE_KEY, parseSchedule)
  return {
    taskFlow,
    schedule: localSchedule
      ? {
          ...schedule,
          entries: mergeLocalScheduleEntries(schedule.entries, localSchedule.entries),
        }
      : schedule,
  }
}

/** 读取单个 JSON 本地键；缺失返回 null，损坏或形状不合法时清理该键并返回 null。 */
function readLocalSection<T>(key: string, parse: (value: unknown) => T | null): T | null {
  const stored = localStorage.getItem(key)
  if (stored === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    localStorage.removeItem(key)
    return null
  }

  const value = parse(parsed)
  if (value === null) localStorage.removeItem(key)
  return value
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : FALLBACK_ERROR_MESSAGE
}

/**
 * 最近一次被编码（接受或提交）的 wire 指纹。
 *
 * 协调器在调用 `commit` 前已校验 revision，但 automation 的完整提交包含两次请求：
 * 配置保存期间用户仍可能产生新草稿。适配器在配置保存后比对指纹，若已出现更新的
 * 草稿就不再执行旧的 schedule 步骤，保留迁移前“配置保存后、schedule 前重新校验”
 * 的保护；迟到的旧提交由协调器按 revision/token 拒绝确认。
 */
let latestEncodedWireFingerprint: string | null = null

function toAutomationWire(draft: AutomationConfigDraft): AutomationConfigWire {
  const entries = normalizeScheduleEntries(draft.schedule.entries)
  return {
    taskFlow: toPersistedTaskFlow(draft.taskFlow),
    schedule: {
      enabled: draft.schedule.enabled,
      times: activeScheduleTimes(entries),
    },
  }
}

export const automationConfigAdapter: ConfigPersistenceAdapter<
  AutomationConfigDraft,
  AutomationConfigWire
> = {
  key: AUTOMATION_CONFIG_KEY,
  pendingKey: AUTOMATION_CONFIG_PENDING_KEY,
  commitDelayMs: AUTOMATION_CONFIG_COMMIT_DELAY_MS,

  encodeDraft(draft) {
    const wire = toAutomationWire(draft)
    latestEncodedWireFingerprint = JSON.stringify(wire)
    return wire
  },

  /**
   * 草稿等价判断必须覆盖本地 schedule.entries：禁用项不进入 wire，只比较 wire 会把
   * “编辑/删除禁用时间点”当成无变化，协调器就会跳过本地写回并静默丢弃操作。
   * 同时记录本次草稿对应的 wire，供完整提交在配置保存后判断是否出现了更新的草稿。
   */
  fingerprint(draft) {
    latestEncodedWireFingerprint = JSON.stringify(toAutomationWire(draft))
    return JSON.stringify({
      taskFlow: toPersistedTaskFlow(draft.taskFlow),
      schedule: {
        enabled: draft.schedule.enabled,
        entries: normalizeScheduleEntries(draft.schedule.entries),
      },
    })
  },

  decodeDraft: decodeAutomationConfig,

  readLocalDraft() {
    const taskFlow = readLocalSection(AUTOMATION_TASK_FLOW_KEY, parseTaskFlow)
    const schedule = readLocalSection(AUTOMATION_SCHEDULE_KEY, parseSchedule)
    // 两个键都不可读时没有可恢复的草稿；单个键损坏只丢弃该部分，保留另一部分编辑。
    if (taskFlow === null && schedule === null) return null
    return {
      taskFlow: taskFlow ?? [],
      schedule: schedule ?? { enabled: false, entries: createDefaultScheduleEntries() },
    }
  },

  writeLocalDraft(draft) {
    const entries = normalizeScheduleEntries(draft.schedule.entries)
    localStorage.setItem(AUTOMATION_TASK_FLOW_KEY, JSON.stringify(toPersistedTaskFlow(draft.taskFlow)))
    localStorage.setItem(AUTOMATION_SCHEDULE_KEY, JSON.stringify({
      enabled: draft.schedule.enabled,
      times: activeScheduleTimes(entries),
      entries,
    }))
  },

  async commit(wire): Promise<ConfigCommitResult> {
    const commitFingerprint = JSON.stringify(wire)
    // 直接调用（单元测试或非协调器场景）时没有新的编码；以本次提交为基线。
    latestEncodedWireFingerprint = commitFingerprint
    try {
      const saveResult = await saveUserConfig(AUTOMATION_CONFIG_KEY, {
        taskFlow: wire.taskFlow,
        schedule: { enabled: wire.schedule.enabled, times: wire.schedule.times },
      })
      if (!saveResult.success) return { ok: false, message: getErrorMessage(saveResult) }

      // 配置保存期间已接受更新的草稿：旧提交不再应用自己的 schedule，避免用旧定时
      // 设置覆盖新草稿；协调器随后按 revision/token 丢弃这次确认。
      if (latestEncodedWireFingerprint !== commitFingerprint) {
        return { ok: false, message: '配置已更新，本次定时设置未提交' }
      }

      // 配置已保存但 schedule 失败同样不算完整成功：保留 pending，重试会重跑整段提交。
      const scheduleResult = wire.schedule.enabled && wire.schedule.times.length > 0
        ? await setupSchedule('default', wire.schedule.times, wire.taskFlow)
        : await stopSchedule('default')
      if (!scheduleResult.success) return { ok: false, message: getErrorMessage(scheduleResult) }
      return { ok: true }
    } catch (error) {
      return { ok: false, message: describeError(error) }
    }
  },

  async fetch({ signal }): Promise<ConfigLoadResult> {
    try {
      const result = await loadUserConfig(AUTOMATION_CONFIG_KEY, signal)
      if (!result.success) return { ok: false, message: getErrorMessage(result) }
      return { ok: true, payload: result.data ?? null }
    } catch (error) {
      return { ok: false, message: describeError(error) }
    }
  },
}
