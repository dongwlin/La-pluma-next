/**
 * 作业配置持久化适配器
 *
 * 把作业草稿的本地布局、服务端 wire 形状与完整提交条件集中到域内，页面只通过
 * user-config 协调器读写。配置 key、本地键、pending 键与 300ms 去抖策略都沿用
 * 迁移前的实现，因此旧版本的本地草稿与服务端配置无需迁移即可继续读取。
 *
 * 加载时保留两条旧值迁移：
 * - 作业集执行方式 `app` → `cli`（服务端载荷与本地键都适用）；
 * - raid `1`/`2` → `raid`/`both`（服务端载荷与本地键都适用）。
 *
 * 服务端 wire 始终是
 * `{ taskInputs, advancedParams, autoFormation, copilotSetExecutionMode, copilotSetSelections }`；
 * 界面字段（搜索词、预览、选中索引的瞬时状态）不进入持久化载荷。形状校验在解码时完成，
 * 不可用的载荷返回 null，由协调器回退本地草稿。
 */

import { getErrorMessage } from '@/shared/api'
import {
  loadUserConfig,
  saveUserConfig,
  type ConfigCommitResult,
  type ConfigLoadResult,
  type ConfigPersistenceAdapter,
} from '@/features/user-config'
import type {
  AutoFormationConfig,
  CombatAdvancedParams,
  CombatTaskInputs,
  CopilotSetExecutionMode,
  CopilotSetSelections,
  FormationMode,
} from '../types'

/** 服务端配置 key，与迁移前一致。 */
export const COMBAT_CONFIG_KEY = 'combat-tasks'
/** 本设备未同步草稿标记，成功提交后由协调器删除。 */
export const COMBAT_CONFIG_PENDING_KEY = 'combatConfigSyncPending'
/** 本地草稿键，逐字段保持原布局。 */
export const COMBAT_TASK_INPUTS_KEY = 'combatTaskInputs'
export const COMBAT_ADVANCED_PARAMS_KEY = 'combatAdvancedParams'
export const COMBAT_AUTO_FORMATION_KEY = 'combatAutoFormation'
export const COMBAT_SET_EXECUTION_MODE_KEY = 'combatCopilotSetExecutionMode'
export const COMBAT_SET_SELECTIONS_KEY = 'combatCopilotSetSelections'
/** 与迁移前一致：连续编辑只提交最后一次。 */
export const COMBAT_CONFIG_COMMIT_DELAY_MS = 300

const FALLBACK_ERROR_MESSAGE = '暂时无法连接服务器'
const DEFAULT_SET_EXECUTION_MODE: CopilotSetExecutionMode = 'cli'

export interface CombatConfigDraft {
  taskInputs: CombatTaskInputs
  advancedParams: CombatAdvancedParams
  autoFormation: AutoFormationConfig
  copilotSetExecutionMode: CopilotSetExecutionMode
  copilotSetSelections: CopilotSetSelections
}

/**
 * 默认草稿：与迁移前页面的初始 state 对齐，供加载完成前渲染和缺失字段回填。
 * 每次调用返回新对象，避免共享的嵌套对象被后续更新意外复用。
 */
export function createDefaultCombatDraft(): CombatConfigDraft {
  return {
    taskInputs: {},
    advancedParams: {
      copilot: { ignoreRequirements: true, loopTimes: '1', executionStrategy: 'continue', raid: 'normal' },
      paradoxcopilot: { executionStrategy: 'continue' },
      ssscopilot: { loopTimes: '1' },
    },
    autoFormation: { copilot: 'auto' },
    copilotSetExecutionMode: DEFAULT_SET_EXECUTION_MODE,
    copilotSetSelections: {},
  }
}

/** 旧配置的 raid 值 `1`/`2` 与现行名称都接受，其余值按普通模式处理。 */
export function normalizeRaidValue(value: unknown): 'normal' | 'raid' | 'both' {
  if (value === '1' || value === 'raid') return 'raid'
  if (value === '2' || value === 'both') return 'both'
  return 'normal'
}

/** 与迁移前的 `normalizeAdvancedConfig` 一致：只规范化 copilot 的 raid 值。 */
export function normalizeAdvancedParams(advanced: CombatAdvancedParams): CombatAdvancedParams {
  return {
    ...advanced,
    copilot: {
      ...advanced.copilot,
      raid: normalizeRaidValue(advanced.copilot?.raid),
    },
  }
}

type AdvancedValue = string | number | boolean

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseTaskInputs(value: unknown): CombatTaskInputs | null {
  if (!isRecord(value)) return null
  const inputs: CombatTaskInputs = {}
  for (const [taskId, input] of Object.entries(value)) {
    if (typeof input !== 'string') return null
    inputs[taskId] = input
  }
  return inputs
}

function isAdvancedValue(value: unknown): value is AdvancedValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function parseAdvancedParams(value: unknown): CombatAdvancedParams | null {
  if (!isRecord(value)) return null
  const params: CombatAdvancedParams = {}
  for (const [taskId, rawParams] of Object.entries(value)) {
    if (!isRecord(rawParams)) return null
    const taskParams: Record<string, AdvancedValue> = {}
    for (const [key, entry] of Object.entries(rawParams)) {
      if (!isAdvancedValue(entry)) return null
      taskParams[key] = entry
    }
    params[taskId] = taskParams
  }
  return params
}

function isFormationMode(value: unknown): value is FormationMode | boolean {
  return value === true || value === false || value === 'on' || value === 'off' || value === 'auto'
}

function parseAutoFormation(value: unknown): AutoFormationConfig | null {
  if (!isRecord(value)) return null
  const formation: AutoFormationConfig = {}
  for (const [taskId, mode] of Object.entries(value)) {
    if (!isFormationMode(mode)) return null
    formation[taskId] = mode
  }
  return formation
}

/** 旧值 `app` 在加载时迁移为 `cli`；其余未知值视为载荷不可用。 */
function parseSetExecutionMode(value: unknown): CopilotSetExecutionMode | null {
  if (value === 'app') return 'cli'
  if (value === 'manual' || value === 'cli') return value
  return null
}

function parseCopilotSetSelections(value: unknown): CopilotSetSelections | null {
  if (!isRecord(value)) return null
  const selections: CopilotSetSelections = {}
  for (const [setId, indexes] of Object.entries(value)) {
    if (!Array.isArray(indexes) || !indexes.every(index => Number.isInteger(index))) return null
    selections[setId] = indexes as number[]
  }
  return selections
}

/**
 * 服务端载荷解码。缺失字段按默认草稿补齐（迁移前同样只采用存在的字段）；
 * 字段存在但形状不合法时整份载荷不可用，协调器会回退本地草稿。
 */
function decodeCombatConfig(payload: unknown): CombatConfigDraft | null {
  if (!isRecord(payload)) return null
  const defaults = createDefaultCombatDraft()

  const taskInputs = payload.taskInputs === undefined
    ? defaults.taskInputs
    : parseTaskInputs(payload.taskInputs)
  const advancedParams = payload.advancedParams === undefined
    ? defaults.advancedParams
    : parseAdvancedParams(payload.advancedParams)
  const autoFormation = payload.autoFormation === undefined
    ? defaults.autoFormation
    : parseAutoFormation(payload.autoFormation)
  const copilotSetExecutionMode = payload.copilotSetExecutionMode === undefined
    ? defaults.copilotSetExecutionMode
    : parseSetExecutionMode(payload.copilotSetExecutionMode)
  const copilotSetSelections = payload.copilotSetSelections === undefined
    ? defaults.copilotSetSelections
    : parseCopilotSetSelections(payload.copilotSetSelections)

  if (
    taskInputs === null
    || advancedParams === null
    || autoFormation === null
    || copilotSetExecutionMode === null
    || copilotSetSelections === null
  ) return null

  return {
    taskInputs,
    advancedParams: normalizeAdvancedParams(advancedParams),
    autoFormation,
    copilotSetExecutionMode,
    copilotSetSelections,
  }
}

/** 读取单个 JSON 本地键；缺失返回 null，损坏或形状不合法时清理该键并返回 null。 */
function readJsonSection<T>(key: string, parse: (value: unknown) => T | null): T | null {
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
 * 本地草稿读取。至少有一个字段可读时返回完整草稿（缺失字段用默认值补齐）；
 * 全部缺失或损坏时返回 null，协调器会删除 pending 标记并改读服务端。
 * 单个损坏键只丢弃对应字段，与迁移前的逐键恢复一致。
 */
function readCombatLocalDraft(): CombatConfigDraft | null {
  const defaults = createDefaultCombatDraft()

  const taskInputs = readJsonSection(COMBAT_TASK_INPUTS_KEY, parseTaskInputs)
  const advancedParams = readJsonSection(COMBAT_ADVANCED_PARAMS_KEY, parseAdvancedParams)
  const autoFormation = readJsonSection(COMBAT_AUTO_FORMATION_KEY, parseAutoFormation)
  const copilotSetSelections = readJsonSection(COMBAT_SET_SELECTIONS_KEY, parseCopilotSetSelections)

  // 执行方式以裸字符串保存（与迁移前一致）；非法值按缺失处理，不删除其它字段。
  const storedMode = localStorage.getItem(COMBAT_SET_EXECUTION_MODE_KEY)
  const copilotSetExecutionMode = storedMode === null ? null : parseSetExecutionMode(storedMode)

  if (
    taskInputs === null
    && advancedParams === null
    && autoFormation === null
    && copilotSetExecutionMode === null
    && copilotSetSelections === null
  ) return null

  return {
    taskInputs: taskInputs ?? defaults.taskInputs,
    advancedParams: advancedParams ? normalizeAdvancedParams(advancedParams) : defaults.advancedParams,
    autoFormation: autoFormation ?? defaults.autoFormation,
    copilotSetExecutionMode: copilotSetExecutionMode ?? defaults.copilotSetExecutionMode,
    copilotSetSelections: copilotSetSelections ?? defaults.copilotSetSelections,
  }
}

export const combatConfigAdapter: ConfigPersistenceAdapter<
  CombatConfigDraft,
  CombatConfigDraft
> = {
  key: COMBAT_CONFIG_KEY,
  pendingKey: COMBAT_CONFIG_PENDING_KEY,
  commitDelayMs: COMBAT_CONFIG_COMMIT_DELAY_MS,

  encodeDraft(draft) {
    return {
      taskInputs: draft.taskInputs,
      advancedParams: draft.advancedParams,
      autoFormation: draft.autoFormation,
      copilotSetExecutionMode: draft.copilotSetExecutionMode,
      copilotSetSelections: draft.copilotSetSelections,
    }
  },

  decodeDraft: decodeCombatConfig,

  readLocalDraft: readCombatLocalDraft,

  writeLocalDraft(draft) {
    localStorage.setItem(COMBAT_TASK_INPUTS_KEY, JSON.stringify(draft.taskInputs))
    localStorage.setItem(COMBAT_ADVANCED_PARAMS_KEY, JSON.stringify(draft.advancedParams))
    localStorage.setItem(COMBAT_AUTO_FORMATION_KEY, JSON.stringify(draft.autoFormation))
    localStorage.setItem(COMBAT_SET_EXECUTION_MODE_KEY, draft.copilotSetExecutionMode)
    localStorage.setItem(COMBAT_SET_SELECTIONS_KEY, JSON.stringify(draft.copilotSetSelections))
  },

  async commit(wire): Promise<ConfigCommitResult> {
    try {
      const result = await saveUserConfig(COMBAT_CONFIG_KEY, wire)
      if (!result.success) return { ok: false, message: getErrorMessage(result) }
      return { ok: true }
    } catch (error) {
      return { ok: false, message: describeError(error) }
    }
  },

  async fetch({ signal }): Promise<ConfigLoadResult> {
    try {
      const result = await loadUserConfig(COMBAT_CONFIG_KEY, signal)
      if (!result.success) return { ok: false, message: getErrorMessage(result) }
      return { ok: true, payload: result.data ?? null }
    } catch (error) {
      return { ok: false, message: describeError(error) }
    }
  },
}
