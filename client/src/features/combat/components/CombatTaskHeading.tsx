/**
 * 作业卡头部与执行按钮
 *
 * 只渲染任务名称、说明与当前执行投影；不创建执行状态机，也不判断停止
 * 目标。两份作业卡共用，仅保留迁移前各自的按钮间距。
 */

import { Play, Square } from 'lucide-react'
import { Button } from '@/shared/ui'
import type { CombatTask } from '../types'

export interface CombatRunActionProps {
  automationAvailable: boolean
  unavailableMessage: string
  isRunning: boolean
  isStopping: boolean
  isSubmitting: boolean
  onExecute: () => void
  onStop: () => void
  /** 迁移前两份卡片的按钮间距不同；保持原类名即可保持基线。 */
  buttonClassName: string
}

export function CombatRunAction({
  automationAvailable,
  unavailableMessage,
  isRunning,
  isStopping,
  isSubmitting,
  onExecute,
  onStop,
  buttonClassName,
}: CombatRunActionProps) {
  return isRunning ? (
    <Button
      onClick={onStop}
      disabled={isStopping}
      loading={isStopping}
      loadingText="正在终止"
      variant="danger"
      size="md"
      icon={!isStopping ? <Square size={14} fill="currentColor" aria-hidden="true" /> : undefined}
      className={buttonClassName}
    >
      终止执行
    </Button>
  ) : (
    <Button
      onClick={onExecute}
      disabled={!automationAvailable}
      loading={isSubmitting}
      loadingText="正在启动"
      title={!automationAvailable ? unavailableMessage : undefined}
      variant="primary"
      size="md"
      icon={<Play size={15} fill="currentColor" aria-hidden="true" />}
      className={buttonClassName}
    >
      立即执行
    </Button>
  )
}

interface CombatTaskHeadingProps extends CombatRunActionProps {
  task: CombatTask
}

export default function CombatTaskHeading({
  task,
  ...run
}: CombatTaskHeadingProps) {
  return (
    <div className="combat-task-heading flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <div className="combat-task-icon">
          {task.icon}
        </div>
        <div className="min-w-0">
          <h4 className="truncate text-lg font-semibold text-primary">{task.name}</h4>
          <p className="mt-1 text-sm leading-relaxed text-secondary">{task.description}</p>
        </div>
      </div>

      <CombatRunAction {...run} />
    </div>
  )
}
