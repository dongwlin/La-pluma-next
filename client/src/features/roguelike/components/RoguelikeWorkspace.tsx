/**
 * 肉鸽工作区容器
 *
 * 页面只负责壳层与页头；跨面板的配置草稿、执行订阅与当前模式集中在这里：
 * - 草稿由 user-config 通道持有，本组件只把 `taskInputs`/`advancedParams` 投影给面板；
 * - 执行由应用级控制器持有，`useRoguelikeExecution` 只创建一份页面适配器；
 * - 当前模式是跨面板的局部交互状态（决定主题与高级字段展示哪一份配置），
 *   不进入持久化载荷；真正卸载后回默认模式，Activity 隐藏/恢复保留。
 */

import { useState } from 'react'
import { Button, SmoothPanel } from '@/shared/ui'
import { useAutomationAvailability, useStatusStore } from '@/features/runtime-status'
import { ScreenMonitor } from '@/features/device-mirror'
import { useUserConfig } from '@/features/user-config'
import { roguelikeConfigAdapter } from '../model/roguelikeConfig'
import {
  DEFAULT_ROGUELIKE_MODE,
  ROGUELIKE_TASKS,
  buildRoguelikeCommandParams,
  validateRoguelikeTaskInput,
} from '../model/roguelikeTasks'
import { useRoguelikeExecution } from '../hooks/useRoguelikeExecution'
import RoguelikeModePanel from './RoguelikeModePanel'
import RoguelikeSettingsPanel from './RoguelikeSettingsPanel'
import RoguelikeThemePanel from './RoguelikeThemePanel'
import type {
  RoguelikeAdvancedParams,
  RoguelikeAdvancedValues,
  RoguelikeMode,
  RoguelikeTaskInputs,
} from '../types'

const EMPTY_TASK_INPUTS: RoguelikeTaskInputs = {}
const EMPTY_ADVANCED_PARAMS: RoguelikeAdvancedParams = {}
const EMPTY_ADVANCED_VALUES: RoguelikeAdvancedValues = {}

export default function RoguelikeWorkspace() {
  const { setMessage: setStatusMessage } = useStatusStore()
  const { isAvailable: automationAvailable, unavailableMessage } = useAutomationAvailability()
  const {
    isRunning,
    isStopping,
    isSubmitting,
    execute,
    stop,
  } = useRoguelikeExecution({ notify: setStatusMessage })
  const {
    draft: configDraft,
    syncState: configSyncState,
    error: configSyncError,
    update: updateConfig,
    retry: retryConfigSave,
  } = useUserConfig(roguelikeConfigAdapter)
  // 协调器负责草稿、pending 与提交队列；面板只从草稿派生当前字段并渲染同步状态。
  const taskInputs = configDraft?.taskInputs ?? EMPTY_TASK_INPUTS
  const advancedParams = configDraft?.advancedParams ?? EMPTY_ADVANCED_PARAMS
  const isRetryingConfigSave = configSyncState === 'saving'
  const [activeMode, setActiveMode] = useState<RoguelikeMode>(DEFAULT_ROGUELIKE_MODE)

  const activeTask = ROGUELIKE_TASKS.find(task => task.id === activeMode) ?? ROGUELIKE_TASKS[0]
  if (!activeTask) return null

  const activeAdvanced = advancedParams[activeTask.id] ?? EMPTY_ADVANCED_VALUES
  const activeTheme = taskInputs[activeTask.id] || ''

  const handleRetryConfigSave = async () => {
    if (isRetryingConfigSave) return
    const saved = await retryConfigSave()
    if (saved) setStatusMessage('肉鸽配置已同步', 'success')
  }

  const handleThemeChange = (value: string) => {
    updateConfig({
      taskInputs: { ...taskInputs, [activeTask.id]: value },
      advancedParams,
    })
  }

  const handleAdvancedChange = (key: string, value: string | number | boolean) => {
    updateConfig({
      taskInputs,
      advancedParams: {
        ...advancedParams,
        [activeTask.id]: {
          ...activeAdvanced,
          [key]: value,
        },
      },
    })
  }

  const handleExecute = async () => {
    if (!automationAvailable) {
      setStatusMessage(unavailableMessage, 'error')
      return
    }

    // 输入校验与命令拼接由纯模型描述，页面/面板不复制字段语义。
    const inputError = validateRoguelikeTaskInput(activeTask.id, taskInputs)
    if (inputError) {
      setStatusMessage(inputError)
      return
    }

    await execute({
      command: activeTask.command,
      params: buildRoguelikeCommandParams(activeTask.id, taskInputs, advancedParams),
      taskName: activeTask.name,
    })
  }

  return (
    <>
      {configSyncError && (
        <div
          role="alert"
          className="status-warning flex min-h-11 flex-wrap items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm leading-5"
        >
          <span className="min-w-0 flex-1">{configSyncError}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            loading={isRetryingConfigSave}
            loadingText="同步中"
            onClick={() => void handleRetryConfigSave()}
            className="min-h-11 shrink-0"
          >
            重新同步
          </Button>
        </div>
      )}

      <div className="roguelike-workspace-grid">
        <RoguelikeModePanel activeMode={activeMode} onModeChange={setActiveMode} />

        <RoguelikeThemePanel
          task={activeTask}
          theme={activeTheme}
          onThemeChange={handleThemeChange}
        />

        <RoguelikeSettingsPanel
          task={activeTask}
          advanced={activeAdvanced}
          onAdvancedChange={handleAdvancedChange}
          execution={{
            isRunning,
            isStopping,
            isSubmitting,
            automationAvailable,
            unavailableMessage,
            onExecute: () => void handleExecute(),
            onStop: () => void stop(),
          }}
        />

        <aside className="roguelike-monitor-column" aria-label="模拟器实时预览">
          <SmoothPanel
            className="roguelike-monitor-panel"
            surfaceClassName="automation-monitor-surface roguelike-monitor-surface"
          >
            <div className="task-monitor-panel is-compact">
              <ScreenMonitor variant="compact" />
            </div>
          </SmoothPanel>
        </aside>
      </div>
    </>
  )
}
