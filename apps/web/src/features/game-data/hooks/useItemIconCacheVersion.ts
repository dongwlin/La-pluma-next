import { useSyncExternalStore } from 'react'
import {
  getItemIconCacheVersion,
  subscribeItemIconCache,
} from '../model/itemIconCache'

export function useItemIconCacheVersion(): number {
  return useSyncExternalStore(
    subscribeItemIconCache,
    getItemIconCacheVersion,
    getItemIconCacheVersion,
  )
}
