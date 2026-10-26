/**
 * 日志页命令结果提示
 *
 * 只负责展示清空/清理/读取反馈；提示内容与自动消失时机仍由工作区在命令
 * 结论后写入。错误使用 assertive，成功使用 polite，关闭按钮有可访问名称。
 */

import { AlertCircle, CheckCircle2, X } from 'lucide-react'
import { IconButton, SmoothPanel } from '@/shared/ui'

export interface LogNoticeData {
  readonly type: 'success' | 'error'
  readonly text: string
}

interface LogNoticeProps extends LogNoticeData {
  readonly onDismiss: () => void
}

export default function LogNotice({ type, text, onDismiss }: LogNoticeProps) {
  return (
    <SmoothPanel
      cornerSize="compact"
      surfaceClassName={`log-notice ${type === 'error' ? 'is-error' : 'is-success'}`}
      role={type === 'error' ? 'alert' : 'status'}
      aria-live={type === 'error' ? 'assertive' : 'polite'}
    >
      {type === 'error'
        ? <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
        : <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />}
      <span>{text}</span>
      <IconButton
        icon={<X className="h-4 w-4" aria-hidden="true" />}
        onClick={onDismiss}
        variant="ghost"
        size="sm"
        title="关闭提示"
        aria-label="关闭提示"
      />
    </SmoothPanel>
  )
}
