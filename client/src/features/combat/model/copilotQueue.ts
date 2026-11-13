import { isRecord } from '@/shared/api'
import type { CopilotQueueRunEntry } from '../api'
import type { CopilotDifficulty, CopilotRaid, CopilotSetInfo } from '../types'
import { parseCopilotUri, quoteCopilotPathForInput } from '../utils/copilotUri'
import type { CopilotDetailOperator } from './copilotDetail'
import { copilotDifficultyFromFlags, isPresetFormationContent } from './copilotSelection'

export type CopilotQueueSource = 'link' | 'set' | 'file'

export type CopilotQueueMoveDirection = 'up' | 'down'

export interface CopilotQueueEntry {
  id: string
  source: CopilotQueueSource
  uri: string
  title: string
  /** 作业站 `doc.details` 原文；本地文件同名字段同源。 */
  details?: string
  stage?: string
  stageId?: string
  apCost?: number | null
  presetFormation?: boolean
  supportsRaid?: boolean
  recommendedMode?: CopilotDifficulty
  operators?: string[]
  groups?: string[]
  operatorDetails?: CopilotDetailOperator[]
  completedModes?: Array<'normal' | 'raid'>
  setId?: string
  setItemIndex?: number
  fileName?: string
  addedAt: number
}

export interface CopilotQueueFileMetadata {
  title?: string
  details?: string
  stage?: string
  presetFormation?: boolean
  recommendedMode?: CopilotDifficulty
  operators: string[]
  groups: string[]
}

export interface CopilotQueueAddResult {
  entries: CopilotQueueEntry[]
  added: number
}

export const COPILOT_QUEUE_LIMIT = 50

let fallbackIdCounter = 0

const readText = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value : undefined
)

export function createCopilotQueueEntryId(): string {
  const cryptoApi = typeof globalThis.crypto === 'undefined' ? null : globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  fallbackIdCounter += 1
  return `queue-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}`
}

function splitCopilotNames(value: string | undefined): { operators: string[]; groups: string[] } {
  const names = (value ?? '')
    .split('、')
    .map(name => name.trim())
    .filter(name => Boolean(name) && name !== '未知')
  const groups = names
    .filter(name => name.startsWith('[') && name.endsWith(']'))
    .map(name => name.slice(1, -1))
  const operators = names.filter(name => !(name.startsWith('[') && name.endsWith(']')))
  return { operators, groups }
}

function withCopilotNames(
  displayOperators: string | undefined,
  groupNames: readonly string[] | undefined,
  operatorDetails: readonly CopilotDetailOperator[] | undefined,
) {
  const names = splitCopilotNames(displayOperators)
  const groups = groupNames?.length ? [...groupNames] : names.groups
  return {
    ...(names.operators.length ? { operators: names.operators } : {}),
    ...(groups.length ? { groups } : {}),
    ...(operatorDetails?.length ? { operatorDetails: [...operatorDetails] } : {}),
  }
}

export function buildCopilotQueueEntries(
  preview: CopilotSetInfo,
  addedAt = Date.now(),
): CopilotQueueEntry[] {
  if (preview.type === 'set') {
    return (preview.copilots ?? []).map((item, index) => ({
      id: createCopilotQueueEntryId(),
      source: 'set',
      uri: item.uri || `prts://${item.id}`,
      title: item.name || item.stage || `作业 #${item.id}`,
      details: item.details,
      stage: item.stage,
      stageId: item.stageId,
      apCost: item.apCost,
      presetFormation: item.presetFormation,
      supportsRaid: item.supportsRaid,
      recommendedMode: item.recommendedMode,
      ...withCopilotNames(item.operators, item.groupNames, item.operatorDetails),
      completedModes: item.completedModes,
      setId: preview.id,
      setItemIndex: index,
      addedAt,
    }))
  }

  return [{
    id: createCopilotQueueEntryId(),
    source: 'link',
    uri: `prts://${preview.id}`,
    title: preview.name || preview.stage || `作业 #${preview.id}`,
    details: preview.details,
    stage: preview.stage,
    stageId: preview.stageId,
    recommendedMode: preview.recommendedMode,
    ...(preview.presetFormation ? { presetFormation: true, supportsRaid: false } : {}),
    ...withCopilotNames(preview.operators, preview.groupNames, preview.operatorDetails),
    addedAt,
  }]
}

function readNamedEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names: string[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const name = readText(item.name)
    if (name) names.push(name)
  }
  return names
}

export function parseCopilotQueueFileContent(content: string): CopilotQueueFileMetadata {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return { operators: [], groups: [] }
  }
  if (!isRecord(parsed)) return { operators: [], groups: [] }
  const documentation = isRecord(parsed.doc) ? parsed.doc : null
  const recommendedMode = copilotDifficultyFromFlags(parsed.difficulty)
  const presetFormation = isPresetFormationContent(parsed)
  return {
    title: readText(documentation?.title),
    details: readText(documentation?.details),
    stage: readText(parsed.stage_name),
    ...(presetFormation ? { presetFormation: true } : {}),
    ...(recommendedMode ? { recommendedMode } : {}),
    operators: readNamedEntries(parsed.opers),
    groups: readNamedEntries(parsed.groups),
  }
}

export interface CopilotQueueFileEntryOptions {
  /** 服务端解析后的展示关卡；缺省时沿用文件里的 `stage_name`。 */
  stage?: string
  stageId?: string
  addedAt?: number
}

export function buildCopilotQueueEntryFromFile(
  path: string,
  fileName: string,
  content: string,
  options: CopilotQueueFileEntryOptions = {},
): CopilotQueueEntry {
  const metadata = parseCopilotQueueFileContent(content)
  const fallbackTitle = fileName.replace(/\.json$/i, '').trim() || path
  return {
    id: createCopilotQueueEntryId(),
    source: 'file',
    uri: path,
    title: metadata.title ?? fallbackTitle,
    details: metadata.details,
    stage: options.stage ?? metadata.stage,
    stageId: options.stageId,
    ...(metadata.presetFormation ? { presetFormation: true, supportsRaid: false } : {}),
    recommendedMode: metadata.recommendedMode,
    ...(metadata.operators.length ? { operators: metadata.operators } : {}),
    ...(metadata.groups.length ? { groups: metadata.groups } : {}),
    fileName,
    addedAt: options.addedAt ?? Date.now(),
  }
}

export function addCopilotQueueEntries(
  current: readonly CopilotQueueEntry[],
  incoming: readonly CopilotQueueEntry[],
  limit = COPILOT_QUEUE_LIMIT,
): CopilotQueueAddResult {
  const entries = [...current]
  const uris = new Set(current.map(entry => entry.uri))
  const ids = new Set(current.map(entry => entry.id))
  let added = 0

  for (const entry of incoming) {
    if (entries.length >= limit) break
    if (uris.has(entry.uri)) continue
    const id = ids.has(entry.id) ? createCopilotQueueEntryId() : entry.id
    entries.push(id === entry.id ? entry : { ...entry, id })
    uris.add(entry.uri)
    ids.add(id)
    added += 1
  }

  return { entries, added }
}

export function removeCopilotQueueEntry(
  entries: readonly CopilotQueueEntry[],
  id: string,
): CopilotQueueEntry[] {
  if (!entries.some(entry => entry.id === id)) return [...entries]
  return entries.filter(entry => entry.id !== id)
}

export function moveCopilotQueueEntry(
  entries: readonly CopilotQueueEntry[],
  id: string,
  direction: CopilotQueueMoveDirection,
): CopilotQueueEntry[] {
  const index = entries.findIndex(entry => entry.id === id)
  if (index < 0) return [...entries]
  const target = direction === 'up' ? index - 1 : index + 1
  if (target < 0 || target >= entries.length) return [...entries]
  const next = [...entries]
  const [entry] = next.splice(index, 1)
  if (!entry) return [...entries]
  next.splice(target, 0, entry)
  return next
}

export function toggleCopilotQueueSelection(
  selected: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function toggleAllCopilotQueueSelection(
  entries: readonly CopilotQueueEntry[],
  selected: ReadonlySet<string>,
): Set<string> {
  const allSelected = entries.length > 0 && entries.every(entry => selected.has(entry.id))
  return allSelected ? new Set() : new Set(entries.map(entry => entry.id))
}

export function checkedCopilotQueueEntries(
  entries: readonly CopilotQueueEntry[],
  selected: ReadonlySet<string>,
): CopilotQueueEntry[] {
  return entries.filter(entry => selected.has(entry.id))
}

export function copilotQueueEntryArgument(entry: CopilotQueueEntry): string {
  return entry.source === 'file' ? quoteCopilotPathForInput(entry.uri) : entry.uri
}

function unquotePath(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed
  const quote = trimmed[0]
  if ((quote === '"' || quote === "'") && trimmed[trimmed.length - 1] === quote) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function toCopilotQueueRunEntry(
  entry: CopilotQueueEntry,
  mode: CopilotRaid = 'normal',
): CopilotQueueRunEntry | null {
  const entryMode = entry.presetFormation ? 'normal' : mode
  if (entry.source === 'file') {
    const filename = unquotePath(entry.uri)
    return filename ? { clientId: entry.id, source: 'file', filename, mode: entryMode } : null
  }
  const parsed = parseCopilotUri(entry.uri)
  if (!parsed || parsed.isSet) return null
  const copilotId = Number(parsed.id)
  if (!Number.isInteger(copilotId) || copilotId <= 0) return null
  return { clientId: entry.id, source: 'prts', copilotId, mode: entryMode }
}

export function toCopilotQueueRunEntries(
  entries: readonly CopilotQueueEntry[],
  mode: CopilotRaid = 'normal',
  retryModes?: ReadonlyMap<string, CopilotRaid | null>,
): CopilotQueueRunEntry[] {
  const mapped: CopilotQueueRunEntry[] = []
  for (const entry of entries) {
    const runEntry = toCopilotQueueRunEntry(entry, retryModes?.get(entry.id) ?? mode)
    if (runEntry) mapped.push(runEntry)
  }
  return mapped
}
