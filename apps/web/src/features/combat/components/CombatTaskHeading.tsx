import { ChevronRight, LoaderCircle } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import type { CombatTask } from '../types'

const RUN_ACTION_BUTTON_CLASS = 'combat-task-run-button min-h-11 px-4 text-sm sm:px-5'

export interface CombatRunActionProps {
  automationAvailable: boolean
  unavailableMessage: string
  isRunning: boolean
  isStopping: boolean
  isSubmitting: boolean
  isWaitingForNext?: boolean
  isContinuing?: boolean
  onExecute: () => void
  onStop: () => void
  onStartNext?: () => void
}

export function CombatRunAction({
  automationAvailable,
  unavailableMessage,
  isRunning,
  isStopping,
  isSubmitting,
  isWaitingForNext = false,
  isContinuing = false,
  onExecute,
  onStop,
  onStartNext,
}: CombatRunActionProps) {
  if (isWaitingForNext) {
    return (
      <div className="grid grid-cols-2 gap-2">
        <Button
          onClick={onStartNext}
          disabled={!automationAvailable || isContinuing || isStopping}
          aria-busy={isContinuing || undefined}
          title={!automationAvailable ? unavailableMessage : undefined}
          className={RUN_ACTION_BUTTON_CLASS}
        >
          {isContinuing
            ? <><LoaderCircle className="animate-spin" aria-hidden="true" />正在开始</>
            : (
              <>
                <ChevronRight size={16} aria-hidden="true" />
                开始下一关
              </>
            )}
        </Button>
        <Button
          onClick={onStop}
          disabled={isStopping}
          aria-busy={isStopping || undefined}
          variant="secondary"
          className={RUN_ACTION_BUTTON_CLASS}
        >
          {isStopping
            ? <><LoaderCircle className="animate-spin" aria-hidden="true" />正在终止</>
            : '终止执行'}
        </Button>
      </div>
    )
  }

  return isRunning ? (
    <Button
      onClick={onStop}
      disabled={isStopping}
      aria-busy={isStopping || undefined}
      variant="destructive"
      className={RUN_ACTION_BUTTON_CLASS}
    >
      {isStopping
        ? <><LoaderCircle className="animate-spin" aria-hidden="true" />正在终止</>
        : '终止执行'}
    </Button>
  ) : (
    <Button
      onClick={onExecute}
      disabled={!automationAvailable || isSubmitting}
      aria-busy={isSubmitting || undefined}
      title={!automationAvailable ? unavailableMessage : undefined}
      className={RUN_ACTION_BUTTON_CLASS}
    >
      {isSubmitting
        ? <><LoaderCircle className="animate-spin" aria-hidden="true" />正在启动</>
        : '立即执行'}
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
    <div className="combat-task-heading flex flex-col gap-3.5 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0">
        <h4 className="truncate text-lg font-semibold text-foreground">{task.name}</h4>
      </div>

      <CombatRunAction {...run} />
    </div>
  )
}
