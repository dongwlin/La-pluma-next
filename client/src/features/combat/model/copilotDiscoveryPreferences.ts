import { isRecord } from '@/shared/api'
import {
  DEFAULT_COPILOT_MATCH_MODES,
  isCopilotMatchMode,
  type CopilotMatchMode,
} from './copilotDiscovery'
import { normalizeOperatorSelection, type OperatorSelection } from './operatorFilter'

export type CopilotDiscoveryViewPreference = 'grid' | 'list'

export const COPILOT_OPERATOR_FILTER_STORAGE_KEY = 'la-pluma-copilot-operator-filter-v1'
export const COPILOT_MATCH_STORAGE_KEY = 'la-pluma-copilot-operator-match-v1'
export const COPILOT_DISCOVERY_VIEW_STORAGE_KEY = 'la-pluma-copilot-discovery-view-v1'

export interface CopilotOperatorFilterPreference {
  selection: OperatorSelection
  enabled: boolean
  remember: boolean
}

export interface CopilotMatchPreference {
  enabled: boolean
  modes: readonly CopilotMatchMode[]
}

const readStored = (key: string): unknown => {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(key)
  } catch {
    return null
  }
  if (stored === null) return null
  try {
    return JSON.parse(stored)
  } catch {
    removeStored(key)
    return null
  }
}

const removeStored = (key: string) => {
  try {
    localStorage.removeItem(key)
  } catch {
    // 存储被禁用时保持内存态即可。
  }
}

const writeStored = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存储被禁用或已满时保持内存态即可。
  }
}

const readStringArray = (value: unknown): string[] => (
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
)

export function parseCopilotOperatorFilterPreference(value: unknown): CopilotOperatorFilterPreference | null {
  if (!isRecord(value)) return null
  const selection = normalizeOperatorSelection({
    included: readStringArray(value.included),
    excluded: readStringArray(value.excluded),
  })
  return {
    selection,
    enabled: value.enabled !== false,
    remember: value.remember !== false,
  }
}

export function readCopilotOperatorFilterPreference(): CopilotOperatorFilterPreference | null {
  const parsed = parseCopilotOperatorFilterPreference(readStored(COPILOT_OPERATOR_FILTER_STORAGE_KEY))
  if (!parsed) return null
  if (parsed.remember) return parsed
  return {
    selection: { included: [], excluded: [] },
    enabled: true,
    remember: false,
  }
}

export function writeCopilotOperatorFilterPreference(preference: CopilotOperatorFilterPreference): void {
  if (!preference.remember) {
    writeStored(COPILOT_OPERATOR_FILTER_STORAGE_KEY, {
      included: [],
      excluded: [],
      enabled: true,
      remember: false,
    })
    return
  }
  const hasSelection = preference.selection.included.length > 0
    || preference.selection.excluded.length > 0
  if (!hasSelection && preference.enabled) {
    removeStored(COPILOT_OPERATOR_FILTER_STORAGE_KEY)
    return
  }
  writeStored(COPILOT_OPERATOR_FILTER_STORAGE_KEY, {
    included: preference.selection.included,
    excluded: preference.selection.excluded,
    enabled: preference.enabled,
    remember: true,
  })
}

export function parseCopilotMatchPreference(value: unknown): CopilotMatchPreference | null {
  if (!isRecord(value)) return null
  const storedModes = Array.isArray(value.modes)
    ? value.modes.filter(isCopilotMatchMode)
    : null
  return {
    enabled: value.enabled === true,
    modes: storedModes ?? [...DEFAULT_COPILOT_MATCH_MODES],
  }
}

export function readCopilotMatchPreference(): CopilotMatchPreference | null {
  return parseCopilotMatchPreference(readStored(COPILOT_MATCH_STORAGE_KEY))
}

export function writeCopilotMatchPreference(preference: CopilotMatchPreference): void {
  writeStored(COPILOT_MATCH_STORAGE_KEY, {
    enabled: preference.enabled,
    modes: preference.modes,
  })
}

export function readCopilotDiscoveryViewPreference(): CopilotDiscoveryViewPreference | null {
  const value = readStored(COPILOT_DISCOVERY_VIEW_STORAGE_KEY)
  return value === 'grid' || value === 'list' ? value : null
}

export function writeCopilotDiscoveryViewPreference(view: CopilotDiscoveryViewPreference): void {
  writeStored(COPILOT_DISCOVERY_VIEW_STORAGE_KEY, view)
}
