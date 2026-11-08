import { HintTooltip } from '@/shared/ui'
import type {
  CombatTask,
  CopilotRaid,
  CopilotSetExecutionMode,
  FormationMode,
} from '../types'
import type { AdvancedValues } from '../model/combatCommands'
import CombatAdvancedFields from './CombatAdvancedFields'
import CombatSegmentedControl, { type CombatSegmentedOption } from './CombatSegmentedControl'

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

const FORMATION_OPTIONS: readonly CombatSegmentedOption<FormationMode>[] = [
  { value: 'auto', label: '自动决定' },
  { value: 'on', label: '自动编队' },
  { value: 'off', label: '保留当前编队' },
]

const RAID_OPTIONS: readonly CombatSegmentedOption<CopilotRaid>[] = [
  { value: 'normal', label: '普通模式' },
  { value: 'raid', label: '突袭模式' },
  { value: 'both', label: '普通+突袭' },
]

const SET_EXECUTION_MODE_OPTIONS: readonly CombatSegmentedOption<CopilotSetExecutionMode>[] = [
  { value: 'app', label: '顺序执行' },
  { value: 'manual', label: '手动逐关' },
  { value: 'cli', label: '连续执行' },
]

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

      <div className="mb-3">
        <div className="mb-1.5 flex items-center gap-1">
          <span className="text-xs text-secondary">编队</span>
          <HintTooltip
            id="combat-copilot-formation-hint"
            label="编队"
            hint="作业集拆分执行时，“自动决定”会启用自动编队；单作业会使用默认设置。"
          />
        </div>
        <CombatSegmentedControl
          ariaLabel="编队"
          value={formationMode}
          options={FORMATION_OPTIONS}
          onChange={onFormationChange}
          fullWidth
        />
      </div>

      <div className="mb-3">
        <div className="mb-1.5 flex items-center gap-1">
          <span className="text-xs text-secondary">模式</span>
        </div>
        <CombatSegmentedControl
          ariaLabel="模式"
          value={raid}
          options={RAID_OPTIONS}
          onChange={onRaidChange}
          fullWidth
        />
      </div>

      <div>
        <div className="mb-1.5 flex items-center gap-1">
          <span className="text-xs text-secondary">作业集</span>
          <HintTooltip
            id="combat-copilot-set-mode-hint"
            label="作业集"
            hint="顺序执行会保存进度：成功项自动移出待执行，失败项保留待重试。"
          />
        </div>
        <CombatSegmentedControl
          ariaLabel="作业集"
          value={setExecutionMode}
          options={SET_EXECUTION_MODE_OPTIONS}
          onChange={onSetExecutionModeChange}
          fullWidth
        />
      </div>

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
