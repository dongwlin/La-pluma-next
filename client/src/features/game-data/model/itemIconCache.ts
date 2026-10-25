/**
 * 物品图标 URL 的浏览器缓存版本
 *
 * 物品图标来自外部静态资源仓库，同一路径在资源更新后可能替换为新图。浏览器
 * 按完整 URL 缓存图片，只失效 catalog/materials Query 不会替换仍被引用的旧图；
 * 这里维护一个持久化 epoch，资源更新确认成功后推进，`getItemIconUrl()` 把它
 * 作为查询参数，使新旧图片分属不同缓存条目。
 *
 * 该值不是业务资源，不进入 Query 缓存或 Zustand；订阅只用于让使用图标的组件
 * 在更新成功后重新渲染。epoch 使用时间戳而不是会话内计数，浏览器刷新后仍能
 * 与更新前的 URL 区分。
 */

export const ITEM_ICON_CACHE_STORAGE_KEY = 'laPlumaItemIconVersion'

const listeners = new Set<() => void>()

const readStoredVersion = (): number => {
  try {
    const raw = localStorage.getItem(ITEM_ICON_CACHE_STORAGE_KEY)
    const value = raw ? Number(raw) : 0
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

let version = readStoredVersion()

export const getItemIconCacheVersion = (): number => version

export const subscribeItemIconCache = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 资源更新确认成功后推进 epoch；返回值是新版本。
 *
 * 默认使用当前时间戳，保证跨刷新后的 URL 仍不同于更新前。存储不可写时仍推进
 * 内存版本，至少让当前会话重新取图。`at` 仅供测试注入。
 */
export const invalidateItemIconCache = (at = Date.now()): number => {
  const candidate = Number.isFinite(at) ? Math.floor(at) : 0
  version = Math.max(candidate, version + 1)
  try {
    localStorage.setItem(ITEM_ICON_CACHE_STORAGE_KEY, String(version))
  } catch {
    // 隐私模式或配额不可写：保持内存版本并继续通知订阅者。
  }
  for (const listener of [...listeners]) listener()
  return version
}
