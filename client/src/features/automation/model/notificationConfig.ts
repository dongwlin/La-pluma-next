/**
 * 通知配置的领域形状与归一
 *
 * 通知开关与 Telegram 凭据是自动化域的只读资源，由 Query 缓存持有；
 * 保存成功后写回同一 key，不把配置复制进模块级缓存或 Zustand。
 */

export interface TelegramConfig {
  enabled: boolean
  botToken: string
  chatId: string
}

export interface NotificationConfig {
  enabled: boolean
  channels: {
    telegram: TelegramConfig
  }
}

export const emptyNotificationConfig: NotificationConfig = {
  enabled: false,
  channels: {
    telegram: {
      enabled: false,
      botToken: '',
      chatId: '',
    },
  },
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const readString = (value: unknown): string => (typeof value === 'string' ? value : '')

export const cloneNotificationConfig = (
  config: NotificationConfig = emptyNotificationConfig,
): NotificationConfig => ({
  enabled: Boolean(config.enabled),
  channels: {
    telegram: {
      enabled: Boolean(config.channels?.telegram?.enabled),
      botToken: config.channels?.telegram?.botToken || '',
      chatId: config.channels?.telegram?.chatId || '',
    },
  },
})

/**
 * 服务端载荷归一：缺失字段回退空配置；非对象载荷返回 null，交给 Query
 * 作为契约错误展示，而不是把坏数据当成“通知已关闭”。
 */
export function normalizeNotificationConfig(value: unknown): NotificationConfig | null {
  if (value === null || value === undefined) return cloneNotificationConfig()
  if (!isRecord(value)) return null

  const channels = isRecord(value.channels) ? value.channels : {}
  const telegram = isRecord(channels.telegram) ? channels.telegram : {}

  return {
    enabled: Boolean(value.enabled),
    channels: {
      telegram: {
        enabled: Boolean(telegram.enabled),
        botToken: readString(telegram.botToken),
        chatId: readString(telegram.chatId),
      },
    },
  }
}
