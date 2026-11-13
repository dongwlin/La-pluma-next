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
