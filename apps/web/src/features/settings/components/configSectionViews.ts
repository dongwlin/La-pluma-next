import type { ConfigSectionId } from '../model/configSection'

export const CONFIG_SECTION_VIEWS: Record<ConfigSectionId, { readonly name: string }> = {
  connection: { name: '连接' },
  resource: { name: '资源' },
  instance: { name: '实例' },
}
