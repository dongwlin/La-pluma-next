/**
 * 只读配置 section 面板
 *
 * `resource` 与 `instance` 没有可写入口，面板只渲染 MAA 管理的说明与
 * “打开目录”入口。目录路径/状态来自 `settings/config-directory` Query，
 * 与目录卡片共享同一缓存；这里只复用缓存，不在挂载时重取或重试，打开
 * 目录仍是显式命令，不触发 Query 重取。
 */

import { FolderOpen, LockKeyhole } from 'lucide-react'
import { Button, Card, CardContent, CardHeader } from '@/shared/ui'
import { useStatusStore } from '@/features/runtime-status'
import { useSettingsConfigDirectory } from '../hooks/useSettingsConfigDirectory'
import type { ConfigSectionId } from '../model/configSection'
import { CONFIG_SECTION_VIEWS } from './configSectionViews'

export interface ReadOnlyConfigPanelProps {
  readonly section: Exclude<ConfigSectionId, 'connection'>
}

export default function ReadOnlyConfigPanel({ section }: ReadOnlyConfigPanelProps) {
  const setStatusMessage = useStatusStore(state => state.setMessage)
  const {
    path: configDir,
    status: configDirStatus,
    open: openConfigDirectory,
  } = useSettingsConfigDirectory({ cacheOnly: true })
  const view = CONFIG_SECTION_VIEWS[section]

  const handleOpenConfigDir = async () => {
    const result = await openConfigDirectory()
    setStatusMessage(result.success ? '已打开配置目录' : `打开失败: ${result.message}`)
  }

  return (
    <Card smoothCorners className="config-editor-card p-0!">
      <CardHeader
        title={view.name}
        actions={(
          <Button
            type="button"
            onClick={handleOpenConfigDir}
            variant="outline"
            size="sm"
            disabled={configDirStatus !== 'ready' || !configDir}
            icon={<FolderOpen size={16} aria-hidden="true" />}
          >
            打开目录
          </Button>
        )}
      />
      <CardContent>
        {section === 'resource' && (
          <section className="surface-soft flex items-start gap-3 rounded-xl p-(--app-space-panel)" aria-labelledby="resource-config-readonly-title">
            <span className="icon-well flex h-9 w-9 shrink-0 items-center justify-center rounded-lg brand-text">
              <LockKeyhole size={18} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h3 id="resource-config-readonly-title" className="text-sm font-semibold text-primary">资源配置由 MAA 管理</h3>
              <p className="mt-1 text-sm leading-6 text-secondary">当前资源来源保持不变。需要调整时，可打开配置目录编辑对应文件。</p>
            </div>
          </section>
        )}

        {section === 'instance' && (
          <section className="surface-soft flex items-start gap-3 rounded-xl p-(--app-space-panel)" aria-labelledby="instance-config-readonly-title">
            <span className="icon-well flex h-9 w-9 shrink-0 items-center justify-center rounded-lg brand-text">
              <LockKeyhole size={18} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h3 id="instance-config-readonly-title" className="text-sm font-semibold text-primary">实例选项由 MAA 管理</h3>
              <p className="mt-1 text-sm leading-6 text-secondary">触摸模式等实例选项保持当前设置。需要调整时，可打开配置目录编辑对应文件。</p>
            </div>
          </section>
        )}
      </CardContent>
    </Card>
  )
}
