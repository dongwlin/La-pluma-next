import { FolderOpen, RefreshCw } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { Card, CardContent } from '@/shared/ui/card'
import { notify } from '@/shared/notifications'
import SettingsFeedback from './SettingsFeedback'
import { useSettingsConfigDirectory } from '../hooks/useSettingsConfigDirectory'

export default function ConfigDirectoryPanel() {
  const {
    path: configDir,
    status: configDirStatus,
    error: configDirError,
    reload: reloadConfigDir,
    open: openConfigDirectory,
  } = useSettingsConfigDirectory()

  const handleOpenConfigDir = async () => {
    const result = await openConfigDirectory()
    notify(result.success ? '已打开配置目录' : `打开失败: ${result.message}`)
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3.5">
        <div className="flex min-w-0 items-start gap-3.5">
          <FolderOpen size={20} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">配置目录</h2>
            {configDirStatus === 'error' ? (
              <SettingsFeedback
                tone="error"
                message={configDirError ?? '配置目录读取失败'}
                className="mt-2"
                action={(
                  <Button
                    onClick={() => void reloadConfigDir()}
                    variant="outline"
                    size="sm"
                  >
                    <RefreshCw size={16} aria-hidden="true" />
                    重试
                  </Button>
                )}
              />
            ) : (
              <p className="mt-1 wrap-break-word font-mono text-xs leading-5 text-muted-foreground wrap-anywhere" aria-live="polite">
                {configDirStatus === 'loading' ? '正在读取目录...' : configDir}
              </p>
            )}
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Button
            onClick={handleOpenConfigDir}
            variant="outline"
            size="sm"
            className="flex-1 sm:flex-none"
            disabled={configDirStatus !== 'ready' || !configDir}
          >
            <FolderOpen size={16} aria-hidden="true" />
            打开目录
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
