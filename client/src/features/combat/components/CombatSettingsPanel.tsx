/**
 * 自动战斗执行设置面板
 *
 * 编队、突袭模式、作业集执行方式与高级字段都来自工作区传入的配置草稿；
 * 本组件只渲染受控值并调用域内更新回调。
 */

import type {
  CombatTask,
  CopilotRaid,
  CopilotSetExecutionMode,
  FormationMode,
} from '../types'
import type { AdvancedValues } from '../model/combatCommands'
import CombatAdvancedFields from './CombatAdvancedFields'

interface CombatSettingsPanelProps {
  task: CombatTask
  formationMode: FormationMode
  raid: CopilotRaid
  setExecutionMode: CopilotSetExecutionMode
  advanced: AdvancedValues
  onFormationChange: (mode: FormationMode) => void
  onRaidChange: (raid: CopilotRaid) => void
  onSetExecutionModeChange: (mode: CopilotSetExecutionMode) => void
  onAdvancedChange: (key: string, value: string | number | boolean) => void
}

export default function CombatSettingsPanel({
  task,
  formationMode,
  raid,
  setExecutionMode,
  advanced,
  onFormationChange,
  onRaidChange,
  onSetExecutionModeChange,
  onAdvancedChange,
}: CombatSettingsPanelProps) {
  return (
    <div className="combat-workspace-section">
      <h5 className="mb-3 flex items-center space-x-2 text-sm font-semibold text-primary">
        <svg className="w-4 h-4 brand-text" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <span>执行设置</span>
      </h5>

      {/* 自动编队 */}
      <div className="mb-3 space-y-1.5">
        <div className="flex items-center space-x-2">
          <label htmlFor="combat-copilot-formation" className="w-12 shrink-0 text-xs text-secondary">编队</label>
          <select
            id="combat-copilot-formation"
            name="maa-copilot-formation"
            value={formationMode}
            onChange={(e) => onFormationChange(e.target.value as FormationMode)}
            className="app-input app-native-control min-h-11 min-w-0 flex-1 control-surface"
          >
            <option value="auto">自动决定</option>
            <option value="on">自动编队</option>
            <option value="off">保留当前编队</option>
          </select>
        </div>
        <p className="pl-14 text-xs leading-relaxed text-tertiary">
          作业集拆分执行时，“自动决定”会启用自动编队；单作业会使用默认设置。
        </p>
      </div>

      {/* 突袭模式 */}
      <div className="mb-3 flex items-center space-x-2">
        <label htmlFor="combat-copilot-raid" className="w-12 shrink-0 text-xs text-secondary">模式</label>
        <select
          id="combat-copilot-raid"
          name="maa-copilot-raid"
          value={raid}
          onChange={(e) => onRaidChange(e.target.value as CopilotRaid)}
          className="app-input app-native-control min-h-11 min-w-0 flex-1 control-surface"
        >
          <option value="normal">普通模式</option>
          <option value="raid">突袭模式</option>
          <option value="both">普通+突袭</option>
        </select>
      </div>

      {/* 作业集执行方式 */}
      <div className="space-y-1.5">
        <div className="flex items-center space-x-2">
          <label htmlFor="combat-copilot-set-mode" className="w-12 shrink-0 text-xs text-secondary">作业集</label>
          <select
            id="combat-copilot-set-mode"
            name="maa-copilot-set-mode"
            value={setExecutionMode}
            onChange={(e) => onSetExecutionModeChange(e.target.value as CopilotSetExecutionMode)}
            className="app-input app-native-control min-h-11 min-w-0 flex-1 control-surface"
          >
            <option value="app">顺序执行</option>
            <option value="manual">手动逐关</option>
            <option value="cli">连续执行</option>
          </select>
        </div>
        <p className="pl-14 text-xs leading-relaxed text-tertiary">
          顺序执行会保存进度：成功项自动移出待执行，失败项保留待重试。
        </p>
      </div>

      {/* 高级选项 */}
      {task.hasAdvanced && (
        <details className="combat-advanced-disclosure mt-4">
          <summary className="flex min-h-11 cursor-pointer list-none items-center px-3 text-sm font-medium text-secondary">
            高级设置
          </summary>
          <CombatAdvancedFields
            taskId={task.id}
            advanced={advanced}
            onChange={onAdvancedChange}
          />
        </details>
      )}
    </div>
  )
}
