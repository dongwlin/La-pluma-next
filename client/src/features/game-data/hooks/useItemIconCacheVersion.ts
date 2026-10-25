/**
 * 物品图标缓存版本的 React 订阅
 *
 * 组件在渲染图标时读取该版本并传给 `getItemIconUrl`；资源更新成功后 epoch
 * 推进会触发重新渲染，使 `<img src>` 指向新的缓存身份。
 */

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
