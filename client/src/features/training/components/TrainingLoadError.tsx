/**
 * 资源读取失败提示
 *
 * 队列与干员候选共用：保留 `role="alert"` 与显式“重新加载”入口，不自动重试。
 */

import { AlertCircle } from 'lucide-react'
import { Button } from '@/shared/ui'

export interface TrainingLoadErrorProps {
  title: string
  description: string
  onRetry: () => void
}

export default function TrainingLoadError({
  title,
  description,
  onRetry,
}: TrainingLoadErrorProps) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-4 rounded-xl px-6 py-8 text-center status-danger" role="alert">
      <AlertCircle size={22} strokeWidth={1.9} aria-hidden="true" />
      <div className="max-w-md">
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="mt-1 text-sm leading-6">{description}</p>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        重新加载
      </Button>
    </div>
  )
}
