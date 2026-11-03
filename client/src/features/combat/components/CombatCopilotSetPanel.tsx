/**
 * 作业集预览与逐项结果面板
 *
 * 预览对象、选择与 Run 投影由工作区提供；本组件只把派生视图渲染成历史
 * 续跑进度、下一关卡片与逐项状态。续跑进度统计含历史已通关记录，与
 * “本次执行进度”面板分开；勾选、全选、重置与继续都是工作区动作，
 * 面板不创建第二份选择或执行状态。
 *
 * 当前执行项变化时把「执行中」行自动带入视野；用户刚手动滚动过则跳过
 * 一次定位，避免抢走滚动位置。
 */

import { FileText } from 'lucide-react'
import { Button, EmptyState } from '@/shared/ui'
import { useCopilotSetItemFollow } from '../hooks/useCopilotSetItemFollow'
import type { CopilotSetView } from '../model/copilotSetView'
import type { CopilotSetInfo } from '../types'

interface CombatCopilotSetPanelProps {
  preview: CopilotSetInfo | null
  view: CopilotSetView
  selected: ReadonlySet<number>
  isRunning: boolean
  isResetting: boolean
  isContinuing: boolean
  automationAvailable: boolean
  unavailableMessage: string
  onToggle: (index: number) => void
  onToggleAll: () => void
  onOpenReset: () => void
  onStartNext: () => void
  onCancelSet: () => void
}

export default function CombatCopilotSetPanel({
  preview,
  view,
  selected,
  isRunning,
  isResetting,
  isContinuing,
  automationAvailable,
  unavailableMessage,
  onToggle,
  onToggleAll,
  onOpenReset,
  onStartNext,
  onCancelSet,
}: CombatCopilotSetPanelProps) {
  // 当前项自动定位：列表容器与行标记由本面板渲染，跟随策略在 hook 内。
  const listRef = useCopilotSetItemFollow({
    currentIndex: view.currentIndex,
    hasList: preview?.type === 'set' && !!preview.copilots?.length,
  })

  return (
    <div className="combat-workspace-section combat-job-list-section flex flex-1 flex-col">
      <div className="flex items-center justify-between mb-3">
        <h5 className="flex items-center space-x-2 text-sm font-semibold text-primary">
          <svg className="w-4 h-4 brand-text" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
          </svg>
          <span>作业列表</span>
        </h5>
        {preview?.type === 'set' && preview.copilots && !isRunning && (
          <div className="flex items-center gap-2">
            <button
              onClick={onOpenReset}
              disabled={isResetting}
              className="min-h-11 px-1 text-xs text-gray-500 transition-colors hover:text-(--app-accent) disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-400"
            >
              {isResetting ? '重置中...' : '重置进度'}
            </button>
            <span className="h-3 w-px bg-gray-200 dark:bg-white/10" />
            <button
              onClick={onToggleAll}
              className="min-h-11 px-1 text-xs brand-text transition-colors hover:underline"
            >
              {selected.size === preview.copilots.length ? '清空待执行' : '全选待执行'}
            </button>
          </div>
        )}
      </div>

      {/* 作业集预览 */}
      {preview?.type === 'set' && preview.copilots && preview.copilots.length > 0 ? (
        <>
          {(() => {
            const { total, completed, pending, failed, skipped } = view.progress
            const nextIndex = view.resumeIndex
            const nextCopilot = nextIndex >= 0 ? preview.copilots[nextIndex] ?? null : null
            return (
              <div className="mb-3 border-y border-(--app-border) py-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-tertiary">历史续跑进度</div>
                    <div className="mt-1 text-sm font-semibold text-primary">
                      {nextCopilot ? `下次从第 ${nextIndex + 1} 关继续` : '没有待续跑的作业'}
                    </div>
                    <div className="mt-1 truncate text-xs text-tertiary">
                      {view.attemptedCount > 0 ? `本次已执行 ${view.attemptedCount} 个` : `共 ${total} 个作业（含历史通关）`}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <span className="rounded-md px-2 py-1 text-[11px] brand-chip">待 {pending}</span>
                    <span className="rounded-md border border-(--app-border) px-2 py-1 text-[11px] text-secondary">已通关 {completed}</span>
                    <span className={`rounded-md border px-2 py-1 text-[11px] ${failed > 0 ? 'border-rose-400/30 bg-rose-500/10 text-rose-500 dark:text-rose-300' : 'border-(--app-border) text-secondary'}`}>失败 {failed}</span>
                    {skipped > 0 && (
                      <span className="rounded-md border border-(--app-border) px-2 py-1 text-[11px] text-tertiary">跳过 {skipped}</span>
                    )}
                  </div>
                </div>
                <div className="mt-3">
                  <div className="h-1.5 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                    <div
                      className="h-full bg-(--app-accent) transition-all duration-300"
                      style={{ width: `${total > 0 ? (completed / total) * 100 : 0}%` }}
                    />
                  </div>
                  {nextCopilot ? (
                    <div className="mt-2 flex min-w-0 items-center gap-2 border-t border-(--app-border) pt-2 text-xs">
                      <span className="shrink-0 text-tertiary">续跑目标</span>
                      <span className="font-mono brand-text">prts://{nextCopilot.id}</span>
                      <span className="min-w-0 truncate text-secondary">{nextCopilot.stage || nextCopilot.name || `第 ${nextIndex + 1} 关`}</span>
                    </div>
                  ) : (
                    <div className="mt-2 border-t border-(--app-border) pt-2 text-xs text-tertiary">
                      需要重打时点击“重置进度”。
                    </div>
                  )}
                </div>
              </div>
            )
          })()}

          {/* 下一关卡片：等待态与下一项由服务端 run 持有 */}
          {view.waitingEntry && (
            <div className="mb-3 rounded-lg border border-(--app-accent) bg-(--app-accent-soft) p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center space-x-2">
                  <span className="px-2 py-0.5 brand-action text-xs font-medium rounded-sm">下一关</span>
                  <span className="text-xs brand-text">第 {(view.waitingEntryIndex ?? 0) + 1} / {Math.max(preview.copilots.length, view.activeSetRun?.itemCount ?? 0)} 关</span>
                </div>
                <span className="font-mono text-xs brand-text">prts://{view.waitingCopilot?.id ?? view.waitingEntry.copilotId}</span>
              </div>
              <p className="text-sm font-medium text-primary">{view.waitingCopilot?.name || `作业 #${view.waitingEntry.copilotId ?? ''}`}</p>
              {(view.waitingCopilot?.stage || view.waitingEntry.stage) && (
                <p className="text-xs text-secondary">{view.waitingCopilot?.stage || view.waitingEntry.stage}</p>
              )}

              <div className="mt-3 pt-3 border-t border-(--app-border)">
                <p className="text-xs brand-text mb-2">请在游戏中进入下一关界面后点击继续</p>
                <div className="flex space-x-2">
                  <Button
                    onClick={onStartNext}
                    disabled={!automationAvailable || isContinuing}
                    loading={isContinuing}
                    loadingText="正在开始"
                    title={!automationAvailable ? unavailableMessage : undefined}
                    variant="primary"
                    size="md"
                    fullWidth
                  >
                    开始下一关
                  </Button>
                  <Button onClick={onCancelSet} variant="secondary" size="md">取消</Button>
                </div>
              </div>
            </div>
          )}

          {/* 作业列表 */}
          <div
            ref={listRef}
            data-copilot-set-list
            className="flex-1 divide-y divide-(--app-border) overflow-hidden overflow-y-auto rounded-lg border border-(--app-border) bg-(--app-surface-solid)"
          >
            {preview.copilots.map((copilot, idx) => {
              const runStatus = view.itemStatuses.get(idx)
              // 完成语义按所选模式的覆盖情况判定，单个模式成功不等于作业完成。
              const isFailed = runStatus === 'failed'
              const isStopped = runStatus === 'stopped'
              const isFailure = isFailed || isStopped
              const isSuccess = view.runCompletedIndexes.has(idx) && !isFailure
              const isCompleted = isSuccess || isFailure
              const isSkipped = runStatus === 'skipped'
              const isCurrent = runStatus === 'running'
              const isSelected = selected.has(idx)
              // 历史通关只来自服务端持久化进度，取消选择不代表已通关。
              const isHistoryDone = !isCurrent
                && !isSkipped
                && !isCompleted
                && view.historyCompletedIndexes.has(idx)
              const statusLabel = isCurrent
                ? '执行中'
                : isSkipped
                  ? '已跳过'
                  : isFailure
                    ? '待重试'
                    : isSuccess
                      ? '已完成'
                      : isHistoryDone
                        ? '历史已通关'
                        : '待执行'

              return (
                <div
                  key={`${copilot.id}-${idx}`}
                  data-copilot-item-index={idx}
                  className={`flex items-center justify-between gap-3 px-2.5 py-2 text-xs transition-colors ${
                  isCurrent ? 'bg-(--app-accent-soft)' :
                  isSuccess ? 'bg-emerald-500/10' :
                  isFailure ? 'bg-rose-500/10' :
                  isSkipped || isHistoryDone ? 'bg-black/2.5 opacity-70 dark:bg-white/[0.035]' :
                  'hover:bg-(--app-surface-muted)'
                }`}>
                  <div className="flex min-w-0 items-center space-x-2">
                    {/* 勾选框 */}
                    <button
                      type="button"
                      onClick={() => onToggle(idx)}
                      disabled={isRunning}
                      aria-pressed={isSelected}
                      aria-label={`${isSelected ? '取消选择' : '选择'}第 ${idx + 1} 个作业`}
                      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition-colors ${isRunning ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-(--app-accent-soft)'}`}
                    >
                      <span className={`flex h-4 w-4 items-center justify-center rounded-sm border ${
                          isSelected
                            ? 'border-(--app-accent) bg-(--app-accent) text-white'
                            : 'border-(--app-border-strong) bg-(--app-surface-solid)'
                        }`}>
                        {isSelected && (
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </span>
                    </button>
                    <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${
                      isCurrent ? 'bg-(--app-accent) text-white animate-pulse' :
                      isSuccess ? 'bg-(--app-success) text-white' :
                      isFailure ? 'bg-(--app-danger) text-white' :
                      isSkipped || isHistoryDone ? 'bg-black/10 text-tertiary dark:bg-white/10' :
                      'bg-black/5 text-secondary dark:bg-white/10'
                    }`}>
                      {isSuccess ? '✓' : isFailure ? '✗' : isSkipped ? '–' : isHistoryDone ? '✓' : idx + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-primary">{copilot.name || `作业 #${copilot.id}`}</span>
                        {copilot.presetFormation && (
                          <span className="shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] brand-chip">预设编队 · 仅普通</span>
                        )}
                        {copilot.completedModes?.map(mode => (
                          <span key={mode} className="shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                            {mode === 'raid' ? '突袭已完成' : '普通已完成'}
                          </span>
                        ))}
                      </div>
                      {copilot.stage && <div className="mt-0.5 truncate text-xs text-tertiary">{copilot.stage}</div>}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={`min-w-[64px] rounded-md px-2 py-0.5 text-center text-[11px] ${
                      isCurrent ? 'brand-action text-white' :
                      isFailure ? 'bg-rose-500/10 text-rose-500 dark:text-rose-300' :
                      isSelected ? 'brand-chip' :
                      'bg-black/5 text-secondary dark:bg-white/10'
                    }`}>
                      {statusLabel}
                    </span>
                    <span className="hidden font-mono text-tertiary 2xl:inline">prts://{copilot.id}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      ) : preview?.type === 'single' ? (
        <div className="flex-1 border-y border-(--app-border) py-3">
          <div className="flex items-center space-x-2 mb-1">
            <span className="rounded-md px-2 py-0.5 text-xs font-medium brand-chip">单个作业</span>
            <span className="text-xs text-tertiary">ID: {preview.id}</span>
          </div>
          <p className="font-medium text-primary">{preview.name}</p>
          <div className="mt-1 space-x-2 text-xs text-secondary">
            {preview.stage && <span>关卡: {preview.stage}</span>}
            {preview.operators && <span>干员: {preview.operators}</span>}
          </div>
        </div>
      ) : (
        <EmptyState
          compact
          className="combat-job-empty flex-1"
          icon={<FileText size={24} strokeWidth={1.7} />}
          title="等待作业"
          description="输入作业链接即可预览，本地作业可直接执行。"
        />
      )}
    </div>
  )
}
