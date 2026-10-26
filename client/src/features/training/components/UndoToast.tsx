/**
 * 队列移除后的撤销提示
 *
 * 提示通过 portal 挂在 `document.body`，不打断队列工作区的滚动容器；
 * 8 秒后自动关闭，鼠标悬停、键盘焦点或撤销请求进行中都会暂停关闭。
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, X } from 'lucide-react'
import { Button, IconButton } from '@/shared/ui'

export interface UndoToastProps {
  name: string
  pending: boolean
  onUndo: () => void
  onDismiss: () => void
}

export default function UndoToast({ name, pending, onUndo, onDismiss }: UndoToastProps) {
  const [paused, setPaused] = useState(false)
  const dismissRef = useRef(onDismiss)
  useEffect(() => { dismissRef.current = onDismiss }, [onDismiss])
  useEffect(() => {
    if (paused || pending) return
    const timeout = setTimeout(() => dismissRef.current(), 8000)
    return () => clearTimeout(timeout)
  }, [name, paused, pending])
  return createPortal(<div className="training-undo-toast" role="status" aria-live="polite" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocusCapture={() => setPaused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false) }}>
    <Check size={18} aria-hidden="true" /><span className="min-w-0 flex-1">已移除 {name}</span>
    <Button variant="ghost" onClick={onUndo} loading={pending} loadingText="恢复中">撤销</Button>
    <IconButton variant="ghost" aria-label="关闭移除提示" disabled={pending} onClick={onDismiss} icon={<X size={17} />} />
  </div>, document.body)
}
