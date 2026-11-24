import type { ConfigSectionId } from '../model/configSection'
import type { ConfigSection } from '../types'

export type ConfigSectionView = ConfigSection

export const CONFIG_SECTION_VIEWS: Record<ConfigSectionId, ConfigSectionView> = {
  connection: {
    id: 'connection',
    name: '连接',
  },
  resource: {
    id: 'resource',
    name: '资源',
  },
  instance: {
    id: 'instance',
    name: '实例',
  },
}
