/**
 * 设置 section 的 React 适配层
 *
 * 初始值、存储键与 window 事件由 `model/configSection.ts` 拥有；本 hook
 * 只在挂载时订阅外部切换，并在 cleanup 中注销监听。Activity 隐藏会清理
 * Effect，恢复时重新订阅，页面 state 与草稿不受影响。
 */

import { useCallback, useEffect, useState } from 'react'
import {
  readConfigSection,
  subscribeConfigSection,
  writeConfigSection,
  type ConfigSectionId,
} from '../model/configSection'

export interface ConfigSectionController {
  readonly section: ConfigSectionId
  readonly selectSection: (section: ConfigSectionId) => void
}

export function useConfigSection(): ConfigSectionController {
  const [section, setSection] = useState<ConfigSectionId>(readConfigSection)

  useEffect(() => subscribeConfigSection(nextSection => {
    // 外部事件同样推进存储，避免下次挂载回退到旧 section。
    writeConfigSection(nextSection)
    setSection(nextSection)
  }), [])

  const selectSection = useCallback((nextSection: ConfigSectionId) => {
    writeConfigSection(nextSection)
    setSection(nextSection)
  }, [])

  return { section, selectSection }
}
