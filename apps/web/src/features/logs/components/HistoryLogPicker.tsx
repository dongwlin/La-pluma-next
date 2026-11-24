// 历史模式下清理入口保持禁用：清理成功后的选择裁决可能绕过页面的“返回实时”，
// 在未恢复自动滚动前不开放该路径。

import { AlertCircle, ChevronRight, FileText, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/shared/ui/alert'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { EmptyState, Loading } from '@/shared/components'
import type { HistoryFilesPhase } from '../model/historyLogSession'
import { formatLogFileSize } from '../model/logFileSize'
import type { LogFile } from '../types'

interface HistoryLogPickerProps {
  readonly files: readonly LogFile[]
  readonly filesPhase: HistoryFilesPhase
  readonly filesError: string | null
  readonly selectedFile: LogFile | null
  readonly cleanupDisabled: boolean
  readonly onSelect: (file: LogFile) => void
  readonly onCleanup: () => void
  readonly onReload: () => void
}

export default function HistoryLogPicker({
  files,
  filesPhase,
  filesError,
  selectedFile,
  cleanupDisabled,
  onSelect,
  onCleanup,
  onReload,
}: HistoryLogPickerProps) {
  const loading = filesPhase === 'loading' || filesPhase === 'idle'

  return (
    <Card className="log-card log-history-card min-w-0 gap-0 p-0!">
      <CardHeader className="border-b py-3.5">
        <CardTitle role="heading" aria-level={2}>历史日志文件</CardTitle>
        <CardAction>
          <div className="log-console-heading-actions">
            <Badge
              variant="secondary"
              className="hidden bg-primary-soft font-semibold tabular-nums text-primary-strong sm:inline-flex"
            >
              {files.length} 个
            </Badge>
            <Button
              onClick={onReload}
              variant="ghost"
              size="icon-sm"
              disabled={filesPhase === 'loading'}
              aria-label="刷新历史日志列表"
              title="刷新历史日志列表"
              aria-busy={filesPhase === 'loading' || undefined}
            >
              {filesPhase === 'loading'
                ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
            </Button>
            <Button
              onClick={onCleanup}
              variant="outline"
              size="sm"
              disabled={cleanupDisabled}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              清理旧日志
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="log-history-content px-0">
        {filesError && (
          <Alert variant="destructive" className="m-4">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>历史日志列表读取失败</AlertTitle>
            <AlertDescription>{filesError}</AlertDescription>
            <AlertAction>
              <Button type="button" variant="outline" size="sm" onClick={onReload}>
                重新加载
              </Button>
            </AlertAction>
          </Alert>
        )}
        {loading && files.length === 0 && (
          <div className="log-history-state" aria-busy="true">
            <Loading text="正在读取历史日志..." />
          </div>
        )}
        {!loading && !filesError && files.length === 0 && (
          <EmptyState
            compact
            icon={<FileText className="h-5 w-5" aria-hidden="true" />}
            title="暂无历史日志文件"
            description="执行任务后会自动生成"
          />
        )}
        {files.length > 0 && (
          <div className="log-history-list">
            {files.map(file => (
              <button
                type="button"
                key={file.path}
                onClick={() => onSelect(file)}
                className={`log-history-row ${selectedFile?.path === file.path ? 'is-active' : ''}`}
                aria-current={selectedFile?.path === file.path ? 'true' : undefined}
              >
                <span className="log-history-icon"><FileText className="h-4 w-4" aria-hidden="true" /></span>
                <span className="log-history-copy">
                  <strong title={file.name}>{file.name}</strong>
                  <small>{new Date(file.modified).toLocaleString('zh-CN')} · {formatLogFileSize(file.size)}</small>
                </span>
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
