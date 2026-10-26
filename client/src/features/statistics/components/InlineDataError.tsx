/**
 * 统计面板的读取失败提示
 *
 * 干员与仓库面板共用同一套可恢复错误表面；重试按钮的 loading 由调用方
 * 从 Query 的 `isFetching` 派生。
 */

import { Button } from '@/shared/ui'
import Icons from '@/shared/ui/Icons'

interface InlineDataErrorProps {
  title: string
  description: string
  isRetrying: boolean
  onRetry: () => void
}

export default function InlineDataError({
  title,
  description,
  isRetrying,
  onRetry,
}: InlineDataErrorProps) {
  return (
    <div
      className="form-error-surface flex flex-col items-start gap-3 rounded-xl p-4 sm:flex-row sm:items-center sm:justify-between"
      role="alert"
    >
      <div className="min-w-0">
        <p className="font-semibold text-primary">{title}</p>
        <p className="mt-1 wrap-break-word text-sm leading-6 wrap-anywhere form-error-text">{description}</p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        loading={isRetrying}
        loadingText="正在重试..."
        onClick={onRetry}
        className="w-full sm:w-auto"
        icon={<Icons.RefreshCw className="h-4 w-4" />}
      >
        重新加载
      </Button>
    </div>
  )
}
