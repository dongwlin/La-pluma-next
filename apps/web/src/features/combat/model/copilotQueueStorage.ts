import { isRecord } from '@/shared/api'
import type { CopilotDetailOperator } from './copilotDetail'
import {
  COPILOT_QUEUE_LIMIT,
  createCopilotQueueEntryId,
  type CopilotQueueEntry,
} from './copilotQueue'
import { readCopilotRecommendedMode } from './copilotSelection'

export const COPILOT_QUEUE_STORAGE_KEY = 'la-pluma-copilot-queue-v1'

const COPILOT_QUEUE_VERSION = 1

const readText = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value : undefined
)

const readFiniteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
)

const readApCost = (value: unknown): number | null | undefined => (
  value === null ? null : readFiniteNumber(value) ?? undefined
)

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const values = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  return values.length ? values : undefined
}

function readCompletedModes(value: unknown): Array<'normal' | 'raid'> | undefined {
  const modes = readStringArray(value)?.filter(
    (mode): mode is 'normal' | 'raid' => mode === 'normal' || mode === 'raid',
  )
  return modes?.length ? modes : undefined
}

function readOperatorDetails(value: unknown): CopilotDetailOperator[] | undefined {
  if (!Array.isArray(value)) return undefined
  const operators: CopilotDetailOperator[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const name = readText(item.name)
    if (!name) continue
    operators.push({
      name,
      group: readText(item.group),
      elite: readFiniteNumber(item.elite),
      level: readFiniteNumber(item.level),
      skillLevel: readFiniteNumber(item.skillLevel),
      module: typeof item.module === 'string' ? item.module : null,
    })
  }
  return operators.length ? operators : undefined
}

function parseCopilotQueueEntry(value: unknown): CopilotQueueEntry | null {
  if (!isRecord(value)) return null
  const id = readText(value.id)
  const uri = readText(value.uri)
  const source = value.source
  if (!id || !uri || (source !== 'link' && source !== 'set' && source !== 'file')) return null
  const setItemIndex = readFiniteNumber(value.setItemIndex)
  return {
    id,
    source,
    uri,
    title: readText(value.title) ?? readText(value.stage) ?? readText(value.fileName) ?? uri,
    details: readText(value.details),
    stage: readText(value.stage),
    stageId: readText(value.stageId),
    apCost: readApCost(value.apCost),
    presetFormation: value.presetFormation === true ? true : undefined,
    supportsRaid: typeof value.supportsRaid === 'boolean' ? value.supportsRaid : undefined,
    recommendedMode: readCopilotRecommendedMode(value.recommendedMode),
    operators: readStringArray(value.operators),
    groups: readStringArray(value.groups),
    operatorDetails: readOperatorDetails(value.operatorDetails),
    completedModes: readCompletedModes(value.completedModes),
    setId: readText(value.setId),
    setItemIndex: setItemIndex !== null && Number.isInteger(setItemIndex) && setItemIndex >= 0
      ? setItemIndex
      : undefined,
    fileName: readText(value.fileName),
    addedAt: readFiniteNumber(value.addedAt) ?? Date.now(),
  }
}

export function serializeCopilotQueue(entries: readonly CopilotQueueEntry[]): string {
  return JSON.stringify({ version: COPILOT_QUEUE_VERSION, entries })
}

export function parseCopilotQueue(raw: string | null | undefined): CopilotQueueEntry[] {
  if (!raw) return []
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return []
  }
  if (!isRecord(payload) || payload.version !== COPILOT_QUEUE_VERSION) return []
  if (!Array.isArray(payload.entries)) return []

  const entries: CopilotQueueEntry[] = []
  const uris = new Set<string>()
  const ids = new Set<string>()
  for (const value of payload.entries) {
    if (entries.length >= COPILOT_QUEUE_LIMIT) break
    const entry = parseCopilotQueueEntry(value)
    if (!entry || uris.has(entry.uri)) continue
    const id = ids.has(entry.id) ? createCopilotQueueEntryId() : entry.id
    entries.push(id === entry.id ? entry : { ...entry, id })
    uris.add(entry.uri)
    ids.add(id)
  }
  return entries
}

function getCopilotQueueStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function readCopilotQueueStorage(): CopilotQueueEntry[] {
  const storage = getCopilotQueueStorage()
  if (!storage) return []
  try {
    return parseCopilotQueue(storage.getItem(COPILOT_QUEUE_STORAGE_KEY))
  } catch {
    return []
  }
}

export function writeCopilotQueueStorage(entries: readonly CopilotQueueEntry[]): boolean {
  const storage = getCopilotQueueStorage()
  if (!storage) return false
  try {
    storage.setItem(COPILOT_QUEUE_STORAGE_KEY, serializeCopilotQueue(entries))
    return true
  } catch {
    return false
  }
}
