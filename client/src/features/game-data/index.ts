/**
 * 游戏数据微域公开面
 * 仓库、持有干员与干员目录的唯一 API、类型与 query key 归属。
 */

export { getAllOperators, getDepotData, getItemIconUrl, getOperBoxData } from './api'
export { useItemIconCacheVersion } from './hooks/useItemIconCacheVersion'
export {
  ITEM_ICON_CACHE_STORAGE_KEY,
  getItemIconCacheVersion,
  invalidateItemIconCache,
  subscribeItemIconCache,
} from './model/itemIconCache'
export { GAME_DATA_DOMAIN, gameDataKeys } from './model/queryKeys'
export {
  depotQueryOptions,
  operBoxQueryOptions,
  operatorCatalogQueryOptions,
} from './model/queries'
export type { GameDataResource } from './model/queryKeys'
export type { DepotDataDetailed, DepotItem, OperBoxData, OperatorDetailed } from './types'
