/**
 * 作业信息面板
 *
 * 只展示当前预览与作业集视图派生结果；预览读取、选择与执行仍由工作区
 * 及其领域所有者持有。清除预览只结束本地展示，不影响后台 Run。
 */

import { Info } from 'lucide-react'
import { Button, EmptyState } from '@/shared/ui'
import type { CopilotSetView } from '../model/copilotSetView'
import type { CopilotSetInfo } from '../types'

interface CombatCopilotInfoPanelProps {
  preview: CopilotSetInfo | null
  view: CopilotSetView
  isRunning: boolean
  onClear: () => void
}

export default function CombatCopilotInfoPanel({
  preview,
  view,
  isRunning,
  onClear,
}: CombatCopilotInfoPanelProps) {
  return (
    <div className="combat-workspace-section">
      <h5 className="mb-3 flex items-center space-x-2 text-sm font-semibold text-primary">
        <svg className="w-4 h-4 brand-text" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>作业信息</span>
      </h5>

      {preview ? (
        <div className="space-y-2">
          {preview.type === 'set' && preview.copilots ? (
            <>
              <div className="flex items-center space-x-2">
                <span className="rounded-md px-2 py-0.5 text-xs font-medium brand-chip">作业集</span>
                <span className="text-xs text-tertiary">已选 {view.selectedCount}/{preview.copilots.length} 个</span>
              </div>

              {/* 当前进度 */}
              <div className="flex items-center space-x-2 text-xs">
                <span className="text-tertiary">进度</span>
                <span className="font-medium brand-text">
                  {isRunning ? `第 ${view.panelIndex + 1} 关` : `${view.completedSelectedCount}/${view.selectedCount} 完成`}
                </span>
              </div>

              {/* 当前作业详情 */}
              {view.panelCopilot && (
                <div className="border-t border-(--app-border) pt-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-tertiary">
                      {isRunning ? '当前作业' : '下一作业'}
                    </span>
                    <span className="font-mono text-xs brand-text">
                      prts://{view.panelCopilot.id}
                    </span>
                  </div>
                  <p className="text-sm font-medium text-primary">
                    {view.panelCopilot.name || `作业 #${view.panelCopilot.id}`}
                  </p>
                  {view.panelCopilot.stage && (
                    <div className="mt-1 text-xs text-secondary">
                      <span className="font-medium">关卡:</span> {view.panelCopilot.stage}
                    </div>
                  )}
                  {view.panelCopilot.operators && (
                    <div className="text-xs text-secondary">
                      <span className="font-medium">干员:</span> {view.panelCopilot.operators}
                    </div>
                  )}
                </div>
              )}

              {preview.note && (
                <p className="text-xs text-tertiary">{preview.note}</p>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center space-x-2">
                <span className="rounded-md px-2 py-0.5 text-xs font-medium brand-chip">单个作业</span>
                <span className="text-xs text-tertiary">ID: {preview.id}</span>
              </div>
              <p className="text-sm font-medium text-primary">{preview.name}</p>
              {preview.stage && (
                <div className="text-xs text-secondary">
                  <span className="font-medium">关卡:</span> {preview.stage}
                </div>
              )}
              {preview.operators && (
                <div className="text-xs text-secondary">
                  <span className="font-medium">干员:</span> {preview.operators}
                </div>
              )}
            </>
          )}
          <Button
            onClick={onClear}
            variant="ghost"
            size="sm"
            className="mt-2 text-xs"
          >
            清除预览
          </Button>
        </div>
      ) : (
        <EmptyState
          compact
          icon={<Info size={22} strokeWidth={1.7} />}
          title="等待预览"
          description="预览作业后会在这里显示详情。"
        />
      )}
    </div>
  )
}
