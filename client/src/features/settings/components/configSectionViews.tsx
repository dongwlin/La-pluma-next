import {
  MonitorSmartphone,
  PackageOpen,
  SlidersHorizontal,
} from 'lucide-react'
import type { ConfigSectionId } from '../model/configSection'
import type { ConfigSection } from '../types'

export interface ConfigSectionView extends ConfigSection {
  readonly description: string
}

export const CONFIG_SECTION_VIEWS: Record<ConfigSectionId, ConfigSectionView> = {
  connection: {
    id: 'connection',
    name: '连接',
    description: 'ADB 与模拟器',
    icon: <MonitorSmartphone aria-hidden="true" />,
  },
  resource: {
    id: 'resource',
    name: '资源',
    description: '来源、镜像与同步',
    icon: <PackageOpen aria-hidden="true" />,
  },
  instance: {
    id: 'instance',
    name: '实例',
    description: '触控与运行选项',
    icon: <SlidersHorizontal aria-hidden="true" />,
  },
}
