import { useCallback, useEffect, useRef, useState } from 'react'
import {
  addCopilotQueueEntries,
  COPILOT_QUEUE_LIMIT,
  moveCopilotQueueEntry,
  removeCopilotQueueEntry,
  toggleAllCopilotQueueSelection,
  toggleCopilotQueueSelection,
  type CopilotQueueEntry,
  type CopilotQueueMoveDirection,
} from '../model/copilotQueue'
import {
  readCopilotQueueStorage,
  writeCopilotQueueStorage,
} from '../model/copilotQueueStorage'

export interface CopilotQueueState {
  entries: CopilotQueueEntry[]
  selected: ReadonlySet<string>
}

export interface CopilotQueueSetSyncResult {
  entries: CopilotQueueEntry[]
  selected: Set<string>
}

type CopilotQueueSetSyncMode = 'add' | 'refresh' | 'reset'

export interface UseCopilotQueueResult extends CopilotQueueState {
  add: (entries: readonly CopilotQueueEntry[]) => number
  remove: (id: string) => void
  move: (id: string, direction: CopilotQueueMoveDirection) => void
  clear: () => void
  toggle: (id: string) => void
  toggleAll: () => void
  syncSet: (
    setId: string,
    entries: readonly CopilotQueueEntry[],
    checkedIndexes: readonly number[],
    mode?: CopilotQueueSetSyncMode,
  ) => number[]
}

export function syncCopilotQueueSetEntries(
  currentEntries: readonly CopilotQueueEntry[],
  currentSelected: ReadonlySet<string>,
  setId: string,
  incoming: readonly CopilotQueueEntry[],
  checkedIndexes: readonly number[],
  mode: CopilotQueueSetSyncMode = 'add',
): CopilotQueueSetSyncResult {
  const incomingByUri = new Map<string, CopilotQueueEntry>()
  for (const entry of incoming) {
    if (!incomingByUri.has(entry.uri)) incomingByUri.set(entry.uri, entry)
  }
  const currentIds = new Set(currentEntries.map(entry => entry.id))
  const checked = new Set(checkedIndexes)
  const updated = currentEntries.map((entry): CopilotQueueEntry => {
    if (entry.setId !== setId) return entry
    const member = incomingByUri.get(entry.uri)
    return member
      ? { ...member, id: entry.id, addedAt: entry.addedAt }
      : { ...entry, source: 'link', setId: undefined, setItemIndex: undefined }
  })
  const entries = mode === 'add' ? addCopilotQueueEntries(updated, incoming).entries : updated
  const selected = new Set(entries.filter(entry => {
    if (entry.setId !== setId || entry.setItemIndex === undefined || !incomingByUri.has(entry.uri)) {
      return currentSelected.has(entry.id)
    }
    return checked.has(entry.setItemIndex)
      && (mode === 'reset' || !currentIds.has(entry.id) || currentSelected.has(entry.id))
  }).map(entry => entry.id))
  return { entries, selected }
}

function createInitialState(): CopilotQueueState {
  const entries = readCopilotQueueStorage().slice(0, COPILOT_QUEUE_LIMIT)
  return { entries, selected: new Set(entries.map(entry => entry.id)) }
}

export function useCopilotQueue(): UseCopilotQueueResult {
  const [state, setState] = useState<CopilotQueueState>(createInitialState)
  const stateRef = useRef(state)

  const commit = useCallback((next: CopilotQueueState) => {
    stateRef.current = next
    setState(next)
  }, [])

  useEffect(() => {
    stateRef.current = state
    writeCopilotQueueStorage(state.entries)
  }, [state])

  const add = useCallback((incoming: readonly CopilotQueueEntry[]): number => {
    const current = stateRef.current
    const result = addCopilotQueueEntries(current.entries, incoming)
    if (!result.added) return 0
    const currentIds = new Set(current.entries.map(entry => entry.id))
    const addedIds = result.entries
      .filter(entry => !currentIds.has(entry.id))
      .map(entry => entry.id)
    commit({
      entries: result.entries,
      selected: new Set([...current.selected, ...addedIds]),
    })
    return result.added
  }, [commit])

  const remove = useCallback((id: string) => {
    const current = stateRef.current
    const entries = removeCopilotQueueEntry(current.entries, id)
    if (entries.length === current.entries.length) return
    const selected = new Set(current.selected)
    selected.delete(id)
    commit({ entries, selected })
  }, [commit])

  const move = useCallback((id: string, direction: CopilotQueueMoveDirection) => {
    const current = stateRef.current
    const entries = moveCopilotQueueEntry(current.entries, id, direction)
    const orderChanged = entries.some((entry, index) => entry.id !== current.entries[index]?.id)
    if (!orderChanged) return
    commit({ entries, selected: current.selected })
  }, [commit])

  const clear = useCallback(() => {
    const current = stateRef.current
    if (!current.entries.length && !current.selected.size) return
    commit({ entries: [], selected: new Set() })
  }, [commit])

  const toggle = useCallback((id: string) => {
    const current = stateRef.current
    if (!current.entries.some(entry => entry.id === id)) return
    commit({
      entries: current.entries,
      selected: toggleCopilotQueueSelection(current.selected, id),
    })
  }, [commit])

  const toggleAll = useCallback(() => {
    const current = stateRef.current
    commit({
      entries: current.entries,
      selected: toggleAllCopilotQueueSelection(current.entries, current.selected),
    })
  }, [commit])

  const syncSet = useCallback((
    setId: string,
    incoming: readonly CopilotQueueEntry[],
    checkedIndexes: readonly number[],
    mode?: CopilotQueueSetSyncMode,
  ) => {
    const current = stateRef.current
    const next = syncCopilotQueueSetEntries(
      current.entries,
      current.selected,
      setId,
      incoming,
      checkedIndexes,
      mode,
    )
    commit(next)
    return next.entries.flatMap(entry => (
      entry.setId === setId && entry.setItemIndex !== undefined && next.selected.has(entry.id)
        ? [entry.setItemIndex]
        : []
    ))
  }, [commit])

  return {
    entries: state.entries,
    selected: state.selected,
    add,
    remove,
    move,
    clear,
    toggle,
    toggleAll,
    syncSet,
  }
}
