/**
 * 用户配置 key 的共享常量
 *
 * 各域适配器定义自己的 wire 语义与提交条件，但 key 是跨域协调的稳定身份：
 * 同一 key 在协调器中只有一个通道，跨域写入前的排空屏障也按 key 找到对应
 * 通道。这里集中列出已接入协调器的三个任务配置 key，避免页面或其它域复制
 * 字符串后与适配器漂移。
 */

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
