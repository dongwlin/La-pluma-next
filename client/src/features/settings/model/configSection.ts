export const CONFIG_SECTION_IDS = ['connection', 'resource', 'instance'] as const

export type ConfigSectionId = (typeof CONFIG_SECTION_IDS)[number]

/** 兼容既有本地存储键；改名会让用户的 section 选择失效。 */
export const CONFIG_SECTION_STORAGE_KEY = 'laPlumaConfigSection'

/** 兼容既有 window 事件；外部代码可据此把设置页切到指定 section。 */
export const CONFIG_SECTION_EVENT = 'la-pluma-config-section'

export const DEFAULT_CONFIG_SECTION: ConfigSectionId = 'connection'

export const isConfigSectionId = (value: unknown): value is ConfigSectionId => (
  typeof value === 'string' && (CONFIG_SECTION_IDS as readonly string[]).includes(value)
)

const defaultStorage = (): Pick<Storage, 'getItem' | 'setItem'> | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const defaultTarget = (): Pick<Window, 'addEventListener' | 'removeEventListener'> | null => {
  try {
    return typeof window === 'undefined' ? null : window
  } catch {
    return null
  }
}

/** 读取已保存的 section；缺失、非法或存储不可用时回退 connection。 */
export function readConfigSection(
  storage: Pick<Storage, 'getItem'> | null = defaultStorage(),
): ConfigSectionId {
  if (!storage) return DEFAULT_CONFIG_SECTION
  try {
    const saved = storage.getItem(CONFIG_SECTION_STORAGE_KEY)
    return isConfigSectionId(saved) ? saved : DEFAULT_CONFIG_SECTION
  } catch {
    return DEFAULT_CONFIG_SECTION
  }
}

/** 写入 section；存储失败不应阻断页面内切换。 */
export function writeConfigSection(
  section: ConfigSectionId,
  storage: Pick<Storage, 'setItem'> | null = defaultStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(CONFIG_SECTION_STORAGE_KEY, section)
  } catch {
    // 本地存储不可用时 section 只在当前页面实例内生效。
  }
}

/**
 * 订阅外部 section 切换。忽略非法 detail；返回注销函数，调用方必须在
 * Effect cleanup 中执行，避免 Activity 隐藏或页面卸载后遗留监听。
 */
export function subscribeConfigSection(
  listener: (section: ConfigSectionId) => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | null = defaultTarget(),
): () => void {
  if (!target) return () => {}

  const handleSectionChange = (event: Event) => {
    if (!isConfigSectionId((event as CustomEvent).detail)) return
    listener((event as CustomEvent).detail as ConfigSectionId)
  }

  target.addEventListener(CONFIG_SECTION_EVENT, handleSectionChange)
  return () => {
    target.removeEventListener(CONFIG_SECTION_EVENT, handleSectionChange)
  }
}
