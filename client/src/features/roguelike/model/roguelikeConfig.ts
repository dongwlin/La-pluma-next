/**
 * 肉鸽配置持久化适配器
 *
 * 把肉鸽草稿的本地布局、服务端 wire 形状与完整提交条件集中到域内，页面只通过
 * user-config 协调器读写。配置 key、本地键、pending 键与 300ms 去抖策略都沿用
 * 迁移前的实现，因此旧版本的本地草稿与服务端配置无需迁移即可继续读取。
 *
 * 服务端 wire 始终是 `{ taskInputs, advancedParams }`；界面字段（模式、标签）不进入
 * 持久化载荷。形状校验在解码时完成，不可用的载荷返回 null，由协调器回退本地草稿。
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
import type { RoguelikeAdvancedParams, RoguelikeTaskInputs } from '../types'

/** 服务端配置 key，与迁移前一致。 */
export const ROGUELIKE_CONFIG_KEY = USER_CONFIG_KEYS.roguelikeTasks
/** 本设备未同步草稿标记，成功提交后由协调器删除。 */
export const ROGUELIKE_CONFIG_PENDING_KEY = USER_CONFIG_PENDING_KEYS[USER_CONFIG_KEYS.roguelikeTasks]
/** 本地草稿键，逐字段保持原布局。 */
export const ROGUELIKE_TASK_INPUTS_KEY = 'roguelikeTaskInputs'
export const ROGUELIKE_ADVANCED_PARAMS_KEY = 'roguelikeAdvancedParams'
/** 与迁移前一致：连续编辑只提交最后一次。 */
export const ROGUELIKE_CONFIG_COMMIT_DELAY_MS = 300

const FALLBACK_ERROR_MESSAGE = '暂时无法连接服务器'

export interface RoguelikeConfigDraft {
  taskInputs: RoguelikeTaskInputs
  advancedParams: RoguelikeAdvancedParams
}

type AdvancedValue = string | number | boolean

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseTaskInputs(value: unknown): RoguelikeTaskInputs | null {
  if (!isRecord(value)) return null
  const inputs: RoguelikeTaskInputs = {}
  for (const [taskId, input] of Object.entries(value)) {
    if (typeof input !== 'string') return null
    inputs[taskId] = input
  }
  return inputs
}

function isAdvancedValue(value: unknown): value is AdvancedValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function parseAdvancedParams(value: unknown): RoguelikeAdvancedParams | null {
  if (!isRecord(value)) return null
  const params: RoguelikeAdvancedParams = {}
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

/**
 * 服务端载荷解码。缺省字段按空草稿处理（迁移前的加载路径同样只采用存在的字段）；
 * 字段存在但形状不合法时整份载荷不可用，协调器会回退本地草稿。
 */
function decodeRoguelikeConfig(payload: unknown): RoguelikeConfigDraft | null {
  if (!isRecord(payload)) return null
  const taskInputs = payload.taskInputs === undefined ? {} : parseTaskInputs(payload.taskInputs)
  const advancedParams = payload.advancedParams === undefined
    ? {}
    : parseAdvancedParams(payload.advancedParams)
  if (taskInputs === null || advancedParams === null) return null
  return { taskInputs, advancedParams }
}

/** 读取单个本地键；缺失返回 null，损坏或形状不合法时清理该键并返回 null。 */
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

export const roguelikeConfigAdapter: ConfigPersistenceAdapter<
  RoguelikeConfigDraft,
  RoguelikeConfigDraft
> = {
  key: ROGUELIKE_CONFIG_KEY,
  pendingKey: ROGUELIKE_CONFIG_PENDING_KEY,
  commitDelayMs: ROGUELIKE_CONFIG_COMMIT_DELAY_MS,

  encodeDraft(draft) {
    return { taskInputs: draft.taskInputs, advancedParams: draft.advancedParams }
  },

  decodeDraft: decodeRoguelikeConfig,

  readLocalDraft() {
    const taskInputs = readLocalSection(ROGUELIKE_TASK_INPUTS_KEY, parseTaskInputs)
    const advancedParams = readLocalSection(ROGUELIKE_ADVANCED_PARAMS_KEY, parseAdvancedParams)
    // 两个键都不可读时没有可恢复的草稿；单个键损坏只丢弃该字段，保留另一部分编辑。
    if (taskInputs === null && advancedParams === null) return null
    return { taskInputs: taskInputs ?? {}, advancedParams: advancedParams ?? {} }
  },

  writeLocalDraft(draft) {
    localStorage.setItem(ROGUELIKE_TASK_INPUTS_KEY, JSON.stringify(draft.taskInputs))
    localStorage.setItem(ROGUELIKE_ADVANCED_PARAMS_KEY, JSON.stringify(draft.advancedParams))
  },

  async commit(wire): Promise<ConfigCommitResult> {
    try {
      const result = await saveUserConfig(ROGUELIKE_CONFIG_KEY, wire)
      if (!result.success) return { ok: false, message: getErrorMessage(result) }
      return { ok: true }
    } catch (error) {
      return { ok: false, message: describeError(error) }
    }
  },

  async fetch({ signal }): Promise<ConfigLoadResult> {
    try {
      const result = await loadUserConfig(ROGUELIKE_CONFIG_KEY, signal)
      if (!result.success) return { ok: false, message: getErrorMessage(result) }
      return { ok: true, payload: result.data ?? null }
    } catch (error) {
      return { ok: false, message: describeError(error) }
    }
  },
}
