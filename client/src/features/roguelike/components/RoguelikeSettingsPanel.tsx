/**
 * 肉鸽高级字段与运行操作面板
 *
 * 字段值来自配置协调器的草稿；运行/停止按钮只调用工作区注入的执行适配器，
 * 不在这里创建第二份执行状态机。
 */

import { Play, Square } from 'lucide-react'
import { Button, Input, Select, SmoothPanel, Switch } from '@/shared/ui'
import { getRoguelikeAdvancedOptions, resolveRoguelikeAdvancedValue } from '../model/roguelikeTasks'
import type { RoguelikeAdvancedValues, RoguelikeTask } from '../types'

interface RoguelikeExecutionControls {
  isRunning: boolean
  isStopping: boolean
  isSubmitting: boolean
  automationAvailable: boolean
  unavailableMessage: string
  onExecute: () => void
  onStop: () => void
}

interface RoguelikeSettingsPanelProps {
  task: RoguelikeTask
  advanced: RoguelikeAdvancedValues
  onAdvancedChange: (key: string, value: string | number | boolean) => void
  execution: RoguelikeExecutionControls
}

export default function RoguelikeSettingsPanel({
  task,
  advanced,
  onAdvancedChange,
  execution,
}: RoguelikeSettingsPanelProps) {
  const options = getRoguelikeAdvancedOptions(task.id)
  const fieldOptions = options.filter(option => option.type !== 'checkbox')
  const toggleOptions = options.filter(option => option.type === 'checkbox')

  return (
    <SmoothPanel className="roguelike-panel roguelike-settings-panel">
      <div className="roguelike-panel-heading">
        <div>
          <h3>策略设置</h3>
          <p>{task.name}</p>
        </div>
        <span>{options.length} 项</span>
      </div>
      <div className="roguelike-panel-body roguelike-settings-body">
        <div className="roguelike-field-grid">
          {fieldOptions.map(option => {
            const displayValue = String(resolveRoguelikeAdvancedValue(option, advanced) ?? '')
            return (
              <div key={option.key}>
                {option.type === 'select' && option.options ? (
                  <Select
                    id={`roguelike-${task.id}-${option.key}`}
                    name={`maa-${task.id}-${option.key}`}
                    label={option.label}
                    value={displayValue}
                    onChange={(value: string) => onAdvancedChange(option.key, value)}
                    options={option.options}
                    hint={option.hint}
                  />
                ) : (
                  <Input
                    id={`roguelike-${task.id}-${option.key}`}
                    name={`maa-${task.id}-${option.key}`}
                    type={option.type === 'number' ? 'number' : 'text'}
                    label={option.label}
                    value={displayValue}
                    onChange={(value: string) => onAdvancedChange(option.key, value)}
                    placeholder={option.placeholder}
                    hint={option.hint}
                  />
                )}
              </div>
            )
          })}
        </div>
        {toggleOptions.length > 0 && (
          <div className="roguelike-toggle-list">
            {toggleOptions.map(option => (
              <div key={option.key} className="roguelike-toggle-row">
                <label
                  htmlFor={`roguelike-${task.id}-${option.key}`}
                  className="roguelike-toggle-label min-h-11"
                >
                  {option.label}
                </label>
                <Switch
                  id={`roguelike-${task.id}-${option.key}`}
                  name={`maa-${task.id}-${option.key}`}
                  checked={resolveRoguelikeAdvancedValue(option, advanced) === true}
                  onChange={(checked: boolean) => onAdvancedChange(option.key, checked)}
                  label={option.label}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="roguelike-panel-footer">
        {execution.isRunning ? (
          <Button
            onClick={execution.onStop}
            disabled={execution.isStopping}
            loading={execution.isStopping}
            loadingText="正在终止"
            variant="danger"
            size="md"
            icon={!execution.isStopping ? <Square size={14} fill="currentColor" aria-hidden="true" /> : undefined}
            className="roguelike-run-button"
          >
            终止执行
          </Button>
        ) : (
          <Button
            onClick={execution.onExecute}
            disabled={!execution.automationAvailable}
            loading={execution.isSubmitting}
            loadingText="正在启动"
            title={!execution.automationAvailable ? execution.unavailableMessage : undefined}
            variant="primary"
            size="md"
            icon={<Play size={15} fill="currentColor" aria-hidden="true" />}
            className="roguelike-run-button"
          >
            立即执行
          </Button>
        )}
      </div>
    </SmoothPanel>
  )
}
