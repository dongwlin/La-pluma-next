/**
 * 配置 section 的展示元数据
 *
 * 与 `model/configSection.ts` 的导航状态分开：这里只有名称、说明与图标，
 * 不持有存储键、事件或能力判断。分段导航与只读 section 面板共用同一份
 * 文案，避免标题与导航名称漂移。
 */

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
    description: '资源来源与目录',
    icon: <PackageOpen aria-hidden="true" />,
  },
  instance: {
    id: 'instance',
    name: '实例',
    description: '运行与触控选项',
    icon: <SlidersHorizontal aria-hidden="true" />,
  },
}
