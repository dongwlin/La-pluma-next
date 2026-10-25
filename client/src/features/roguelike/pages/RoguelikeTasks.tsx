import { useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Check, Play, Square } from 'lucide-react'
import Icons from '@/shared/ui/Icons'
import { PageHeader, Input, Select, Button, SmoothPanel, Switch } from '@/shared/ui'
import { FloatingStatusIndicator, useAutomationAvailability, useStatusStore } from '@/features/runtime-status'
import { ScreenMonitor } from '@/features/device-mirror'
import { useFluidTabIndicator } from '@/shared/hooks/useFluidTabIndicator'
import { useUserConfig } from '@/features/user-config'
import type {
  RoguelikeTask,
  RoguelikeAdvancedOption,
  RoguelikeTaskInputs,
  RoguelikeAdvancedParams
} from '../types'
import { roguelikeConfigAdapter } from '../model/roguelikeConfig'
import { useRoguelikeExecution } from '../hooks/useRoguelikeExecution'

type RoguelikeMode = 'roguelike' | 'reclamation'

const EMPTY_TASK_INPUTS: RoguelikeTaskInputs = {}
const EMPTY_ADVANCED_PARAMS: RoguelikeAdvancedParams = {}

const THEME_PRESETS: Record<RoguelikeMode, Array<{ value: string; label: string }>> = {
  roguelike: [
    { value: 'Phantom', label: '傀影' },
    { value: 'Mizuki', label: '水月' },
    { value: 'Sami', label: '萨米' },
    { value: 'Sarkaz', label: '萨卡兹' },
    { value: 'JieGarden', label: '界园' },
  ],
  reclamation: [
    { value: 'Tales', label: '沙洲遗闻' },
  ],
}

export default function RoguelikeTasks() {
  const shouldReduceMotion = useReducedMotion()
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
  // 协调器负责草稿、pending 与提交队列；页面只从草稿派生当前字段并渲染同步状态。
  const taskInputs = configDraft?.taskInputs ?? EMPTY_TASK_INPUTS
  const advancedParams = configDraft?.advancedParams ?? EMPTY_ADVANCED_PARAMS
  const isRetryingConfigSave = configSyncState === 'saving'
  const [activeMode, setActiveMode] = useState<RoguelikeMode>('roguelike')
  const {
    containerRef: modeTabsRef,
    activeRect: activeModeRect,
    setTabRef: setModeTabRef,
    handleTabKeyDown: handleModeKeyDown,
  } = useFluidTabIndicator(activeMode)

  const handleRetryConfigSave = async () => {
    if (isRetryingConfigSave) return
    const saved = await retryConfigSave()
    if (saved) setStatusMessage('肉鸽配置已同步', 'success')
  }

  const tasks: RoguelikeTask[] = [
    { 
      id: 'roguelike', 
      name: '集成战略', 
      command: 'roguelike', 
      placeholder: '输入主题代号',
      icon: 'Map', 
      hasAdvanced: true,
      description: '自动刷集成战略（肉鸽），支持多个主题'
    },
    { 
      id: 'reclamation', 
      name: '生息演算', 
      command: 'reclamation', 
      placeholder: '输入主题代号',
      icon: 'Plant', 
      hasAdvanced: true,
      description: '自动生息演算模式'
    },
  ]

  const getAdvancedOptions = (taskId: string): RoguelikeAdvancedOption[] => {
    const options: Record<string, RoguelikeAdvancedOption[]> = {
      roguelike: [
        { key: 'mode', label: '模式', type: 'select', param: '--mode', options: [
          { value: '0', label: '刷分模式' },
          { value: '1', label: '刷源石锭' },
          { value: '4', label: '3层后退出' },
        ]},
        { key: 'squad', label: '起始分队', type: 'text', param: '--squad', placeholder: '指挥分队' },
        { key: 'coreChar', label: '核心干员', type: 'text', param: '--core-char', placeholder: '维什戴尔' },
        { key: 'startCount', label: '运行次数', type: 'number', param: '--start-count', placeholder: '无限' },
        { key: 'useSupport', label: '使用助战', type: 'checkbox', param: '--use-support' },
        { key: 'stopAtBoss', label: '最终Boss前停止', type: 'checkbox', param: '--stop-at-final-boss' },
      ],
      reclamation: [
        { key: 'mode', label: '模式', type: 'select', param: '-m', options: [
          { value: '0', label: '刷繁荣度（无存档）' },
          { value: '1', label: '制作工具刷繁荣度' },
        ]},
        { key: 'toolsToCraft', label: '制作工具名称', type: 'text', param: '-C', placeholder: '荧光棒' },
        { key: 'numBatches', label: '批次数', type: 'number', param: '--num-craft-batches', placeholder: '16' },
      ],
    }
    return options[taskId] || []
  }

  const buildCommandParams = (task: RoguelikeTask): string => {
    let params = taskInputs[task.id] || ''
    
    const advanced = advancedParams[task.id] || {}
    const options = getAdvancedOptions(task.id)
    
    options.forEach(option => {
      const value = advanced[option.key]
      if (value !== undefined && value !== '' && value !== false) {
        if (option.type === 'checkbox' && value === true) {
          params += ` ${option.param}`
        } else if (option.type !== 'checkbox') {
          params += ` ${option.param} ${value}`
        }
      }
    })
    
    return params
  }

  const handleExecute = async (task: RoguelikeTask) => {
    if (!automationAvailable) {
      setStatusMessage(unavailableMessage, 'error')
      return
    }

    // 验证输入
    const inputValue = taskInputs[task.id] || ''
    if (task.id === 'roguelike' || task.id === 'reclamation') {
      if (!inputValue.trim()) {
        setStatusMessage('请输入主题名称')
        return
      }
    }

    await execute({
      command: task.command,
      params: buildCommandParams(task),
      taskName: task.name,
    })
  }

  const handleStopTask = async () => {
    await stop()
  }

  const handleInputChange = (taskId: string, value: string) => {
    updateConfig({
      taskInputs: { ...taskInputs, [taskId]: value },
      advancedParams,
    })
  }

  const handleAdvancedChange = (taskId: string, key: string, value: string | number | boolean) => {
    updateConfig({
      taskInputs,
      advancedParams: {
        ...advancedParams,
        [taskId]: {
          ...(advancedParams[taskId] || {}),
          [key]: value
        }
      },
    })
  }

  const renderAdvancedOptions = (task: RoguelikeTask) => {
    const options = getAdvancedOptions(task.id)
    if (options.length === 0) return null
    
    const advanced = advancedParams[task.id] || {}
    
    const fieldOptions = options.filter(option => option.type !== 'checkbox')
    const toggleOptions = options.filter(option => option.type === 'checkbox')

    return (
      <>
        <div className="roguelike-field-grid">
          {fieldOptions.map(option => (
            <div key={option.key}>
              {option.type === 'select' && option.options ? (
                <Select
                  id={`roguelike-${task.id}-${option.key}`}
                  name={`maa-${task.id}-${option.key}`}
                  label={option.label}
                  value={String(advanced[option.key] ?? option.options[0]?.value ?? '')}
                  onChange={(value: string) => handleAdvancedChange(task.id, option.key, value)}
                  options={option.options}
                />
              ) : (
                <Input
                  id={`roguelike-${task.id}-${option.key}`}
                  name={`maa-${task.id}-${option.key}`}
                  type={option.type === 'number' ? 'number' : 'text'}
                  label={option.label}
                  value={advanced[option.key] as string | number ?? ''}
                  onChange={(value: string) => handleAdvancedChange(task.id, option.key, value)}
                  placeholder={option.placeholder}
                />
              )}
            </div>
          ))}
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
                  checked={advanced[option.key] as boolean || false}
                  onChange={(checked: boolean) => handleAdvancedChange(task.id, option.key, checked)}
                  label={option.label}
                />
              </div>
            ))}
          </div>
        )}
      </>
    )
  }

  const activeTask = tasks.find(task => task.id === activeMode) ?? tasks[0]
  if (!activeTask) return null
  const activeTheme = taskInputs[activeTask.id] || ''

  return (
    <div className="app-page ios-workspace-page roguelike-page" data-workbench-tasks>
      <div className="app-stack-section">
        <PageHeader
          title="肉鸽模式"
          subtitle="集成战略与生息演算配置"
          mobileLayout="inline"
          actions={(
            <FloatingStatusIndicator
              className="w-full overflow-hidden sm:w-auto"
              textClassName="truncate whitespace-nowrap"
            />
          )}
        />

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
          <div className="roguelike-mode-area">
            <div className="app-workspace-segments app-liquid-tab-pill roguelike-mode-shell">
              <div
                ref={modeTabsRef}
                className="app-workspace-segment-list roguelike-mode-tabs"
                role="toolbar"
                aria-label="肉鸽模式"
              >
                {activeModeRect.width > 0 && (
                  <motion.div
                    data-testid="roguelike-mode-highlight"
                    aria-hidden="true"
                    className="app-workspace-segment-indicator roguelike-mode-highlight"
                    initial={false}
                    animate={{
                      x: activeModeRect.x,
                      y: activeModeRect.y,
                      width: activeModeRect.width,
                      height: activeModeRect.height,
                    }}
                    transition={shouldReduceMotion
                      ? { duration: 0 }
                      : { type: 'spring', stiffness: 420, damping: 38, mass: 0.72 }}
                  />
                )}
                {tasks.map(task => {
                  const IconComponent = Icons[task.icon as keyof typeof Icons]
                  const selected = activeMode === task.id
                  return (
                    <button
                      key={task.id}
                      ref={(element) => {
                        setModeTabRef(task.id as RoguelikeMode)(element)
                      }}
                      type="button"
                      onClick={() => setActiveMode(task.id as RoguelikeMode)}
                      onKeyDown={(event) => handleModeKeyDown(
                        event,
                        tasks.map(({ id }) => id as RoguelikeMode),
                        setActiveMode,
                      )}
                      aria-pressed={selected}
                      tabIndex={selected ? 0 : -1}
                      className={`app-workspace-segment roguelike-mode-button min-h-11 ${selected ? 'is-selected' : ''}`}
                    >
                      {IconComponent && (
                        <span className="app-workspace-segment-icon roguelike-mode-icon">
                          <IconComponent />
                        </span>
                      )}
                      <span className="app-workspace-segment-copy">
                        <span>{task.name}</span>
                        <small>{task.description}</small>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          <SmoothPanel className="roguelike-panel roguelike-theme-panel">
            <div className="roguelike-panel-heading">
              <div>
                <h3>主题</h3>
                <p>选择本次运行内容</p>
              </div>
              <span>{THEME_PRESETS[activeMode].length} 个可用</span>
            </div>
            <div className="roguelike-panel-body">
              <div className="roguelike-theme-grid">
                {THEME_PRESETS[activeMode].map(theme => {
                  const selected = activeTheme === theme.value
                  return (
                    <button
                      key={theme.value}
                      type="button"
                      onClick={() => handleInputChange(activeTask.id, theme.value)}
                      aria-pressed={selected}
                      className={`roguelike-theme-option min-h-11 ${selected ? 'is-active' : ''}`}
                    >
                      <span className="roguelike-theme-copy">
                        <strong>{theme.label}</strong>
                        <small>{theme.value}</small>
                      </span>
                      {selected && <Check size={15} strokeWidth={2.4} aria-hidden="true" />}
                    </button>
                  )
                })}
              </div>
              <Input
                id={`roguelike-${activeTask.id}-theme`}
                name={`maa-${activeTask.id}-theme`}
                type="text"
                label="自定义主题代号"
                placeholder={activeTask.placeholder}
                value={activeTheme}
                onChange={(value: string) => handleInputChange(activeTask.id, value)}
                className="roguelike-custom-theme"
              />
            </div>
          </SmoothPanel>

          <SmoothPanel className="roguelike-panel roguelike-settings-panel">
            <div className="roguelike-panel-heading">
              <div>
                <h3>策略设置</h3>
                <p>{activeTask.name}</p>
              </div>
              <span>{getAdvancedOptions(activeTask.id).length} 项</span>
            </div>
            <div className="roguelike-panel-body roguelike-settings-body">
              {renderAdvancedOptions(activeTask)}
            </div>
            <div className="roguelike-panel-footer">
              {isRunning ? (
                <Button
                  onClick={handleStopTask}
                  disabled={isStopping}
                  loading={isStopping}
                  loadingText="正在终止"
                  variant="danger"
                  size="md"
                  icon={!isStopping ? <Square size={14} fill="currentColor" aria-hidden="true" /> : undefined}
                  className="roguelike-run-button"
                >
                  终止执行
                </Button>
              ) : (
                <Button
                  onClick={() => handleExecute(activeTask)}
                  disabled={!automationAvailable}
                  loading={isSubmitting}
                  loadingText="正在启动"
                  title={!automationAvailable ? unavailableMessage : undefined}
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
      </div>
    </div>
  )
}
