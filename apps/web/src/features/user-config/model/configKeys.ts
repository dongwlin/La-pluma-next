export const USER_CONFIG_KEYS = {
  combatTasks: 'combat-tasks',
  roguelikeTasks: 'roguelike-tasks',
  automationTasks: 'automation-tasks',
} as const

export type UserConfigKey = (typeof USER_CONFIG_KEYS)[keyof typeof USER_CONFIG_KEYS]

/**
 * 各配置 key 的 pending 标记存储键。
 *
 * 协调器在写入草稿时把 token 写入对应 pending 键；即使对应页面尚未挂载，
 * `settle()` 也能据此发现持久化但未确认的草稿，而不是只看内存中的通道。
 */
export const USER_CONFIG_PENDING_KEYS: Record<UserConfigKey, string> = {
  'combat-tasks': 'combatConfigSyncPending',
  'roguelike-tasks': 'roguelikeConfigSyncPending',
  'automation-tasks': 'automationConfigSyncPending',
}
