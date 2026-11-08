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
  ) => void
}

export function syncCopilotQueueSetEntries(
  currentEntries: readonly CopilotQueueEntry[],
  currentSelected: ReadonlySet<string>,
  setId: string,
  incoming: readonly CopilotQueueEntry[],
  checkedIndexes: readonly number[],
): CopilotQueueSetSyncResult {
  const previousByIndex = new Map<number, CopilotQueueEntry>()
  for (const entry of currentEntries) {
    if (entry.setId === setId && entry.setItemIndex !== undefined) {
      previousByIndex.set(entry.setItemIndex, entry)
    }
  }

  const checked = new Set(checkedIndexes)
  const merged = incoming.map(entry => {
    const previous = entry.setItemIndex === undefined
      ? undefined
      : previousByIndex.get(entry.setItemIndex)
    return previous ? { ...entry, id: previous.id, addedAt: previous.addedAt } : entry
  })
  const kept = currentEntries.filter(entry => entry.setId !== setId)
  const firstSetIndex = currentEntries.findIndex(entry => entry.setId === setId)
  const insertAt = firstSetIndex < 0
    ? kept.length
    : currentEntries.slice(0, firstSetIndex).filter(entry => entry.setId !== setId).length
  const seenUris = new Set<string>()
  const entries = [...kept.slice(0, insertAt), ...merged, ...kept.slice(insertAt)]
    .filter(entry => {
      if (seenUris.has(entry.uri)) return false
      seenUris.add(entry.uri)
      return true
    })
    .slice(0, COPILOT_QUEUE_LIMIT)

  const keptIds = new Set(kept.map(entry => entry.id))
  const entryIds = new Set(entries.map(entry => entry.id))
  const selected = new Set<string>()
  for (const id of currentSelected) {
    if (keptIds.has(id)) selected.add(id)
  }
  for (const entry of merged) {
    if (
      entry.setItemIndex !== undefined
      && checked.has(entry.setItemIndex)
      && entryIds.has(entry.id)
    ) {
      selected.add(entry.id)
    }
  }
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
  ) => {
    const current = stateRef.current
    commit(syncCopilotQueueSetEntries(
      current.entries,
      current.selected,
      setId,
      incoming,
      checkedIndexes,
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
