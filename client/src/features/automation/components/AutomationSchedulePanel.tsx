/**
 * 自动化定时与通知面板
 *
 * 定时编辑直接绑定 `model/automationSchedule.ts`：新增时间点、时/分循环、
 * 重复拒绝、启用/删除与上限都由纯模型决定；面板只把结果交给配置 owner 的
 * `onChange`，不复制草稿、不提交配置、不读写存储。通知设置在面板内组合，
 * 仍由自身所有者管理。
 */

import { motion, useReducedMotion } from 'framer-motion'
import { ChevronDown, ChevronUp, CircleMinus, Clock3 } from 'lucide-react'
import { IconButton, SmoothPanel, Switch } from '@/shared/ui'
import NotificationSettings from './NotificationSettings'
import {
  MAX_SCHEDULE_ENTRIES,
  appendScheduleEntry,
  parseScheduleTime,
  removeScheduleEntry,
  setScheduleEntryEnabled,
  updateScheduleTimeEntry,
  type ScheduleTimeEntry,
} from '../model/automationSchedule'

export interface AutomationScheduleChange {
  enabled?: boolean
  entries?: ScheduleTimeEntry[]
}

interface AutomationSchedulePanelProps {
  enabled: boolean
  entries: ScheduleTimeEntry[]
  /** 执行期间禁用全部编辑；由只读 Run 投影派生。 */
  disabled: boolean
  onChange: (next: AutomationScheduleChange) => void
  onError: (message: string) => void
}

export default function AutomationSchedulePanel({
  enabled,
  entries,
  disabled,
  onChange,
  onError,
}: AutomationSchedulePanelProps) {
  const shouldReduceMotion = useReducedMotion()

  const handleEnabledChange = (nextEnabled: boolean) => {
    onChange({ enabled: nextEnabled })
  }

  const addScheduleTime = () => {
    const nextEntries = appendScheduleEntry(entries)
    if (!nextEntries) {
      onError('没有可添加的执行时间')
      return
    }

    onChange({ entries: nextEntries })
  }

  const removeScheduleTime = (index: number) => {
    onChange({ entries: removeScheduleEntry(entries, index) })
  }

  const updateScheduleTimePart = (index: number, part: 'hour' | 'minute', rawValue: number) => {
    const updated = updateScheduleTimeEntry(entries, index, part, rawValue)
    if (!updated.ok) {
      if (updated.reason === 'duplicate') onError('该执行时间已经存在')
      return
    }

    onChange({ entries: updated.entries })
  }

  const updateScheduleTimeEnabled = (index: number, nextEnabled: boolean) => {
    onChange({ entries: setScheduleEntryEnabled(entries, index, nextEnabled) })
  }

  return (
    <div className="automation-schedule-column">
      <SmoothPanel className="automation-schedule-panel">
        <div className="automation-schedule-heading">
          <div>
            <h3><Clock3 size={16} strokeWidth={1.8} aria-hidden="true" /><span>定时与通知</span></h3>
            <p>自动运行与结果推送</p>
          </div>
          <div className="automation-schedule-actions">
            <Switch
              checked={enabled}
              onChange={handleEnabledChange}
              disabled={disabled}
              label="定时执行"
              className="automation-section-switch"
            />
          </div>
        </div>

        {enabled ? (
          <motion.div
            className="automation-schedule-body"
            initial={shouldReduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.2 }}
          >
            <div className="automation-schedule-list-heading">
              <span>执行时间</span>
              <div className="automation-schedule-list-heading-actions">
                <small aria-label={`已设置 ${entries.length} 个执行时间`}>
                  {entries.length} 个
                </small>
                {entries.length < MAX_SCHEDULE_ENTRIES && (
                  <button
                    type="button"
                    onClick={addScheduleTime}
                    disabled={disabled}
                    className="automation-schedule-add"
                  >
                    <span className="automation-schedule-add-plus" aria-hidden="true">+</span>
                    <span className="automation-schedule-add-text">新增定时</span>
                  </button>
                )}
              </div>
            </div>
            <div className="automation-schedule-times">
              {entries.map((entry, index) => {
                const { hour, minute } = parseScheduleTime(entry.time)
                const hourId = `automation-schedule-hour-${index}`
                const minuteId = `automation-schedule-minute-${index}`
                const hourDisplay = String(hour)
                const minuteDisplay = String(minute).padStart(2, '0')

                return (
                  <div
                    key={`schedule-time-${index}`}
                    className={`automation-schedule-time-row${entry.enabled ? '' : ' is-disabled'}`}
                  >
                    {entries.length > 1 ? (
                      <IconButton
                        icon={<CircleMinus size={22} strokeWidth={1.8} aria-hidden="true" />}
                        variant="ghost"
                        size="md"
                        onClick={() => removeScheduleTime(index)}
                        disabled={disabled}
                        className="automation-schedule-remove min-h-11 min-w-11"
                        title="删除时间点"
                        aria-label={`删除第 ${index + 1} 个时间点`}
                      />
                    ) : <span className="automation-schedule-remove-placeholder" aria-hidden="true" />}

                    <div className="automation-schedule-time-fields" role="group" aria-label={`第 ${index + 1} 个执行时间`}>
                      <span className="automation-schedule-time-unit" aria-hidden="true">时</span>
                      <div className="automation-schedule-stepper">
                        <label htmlFor={hourId} className="sr-only">第 {index + 1} 个执行时间的小时</label>
                        <input
                          id={hourId}
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={hourDisplay}
                          disabled={disabled}
                          className="automation-schedule-stepper-input"
                          onChange={(event) => {
                            const digits = event.target.value.replace(/\D/g, '').slice(0, 2)
                            if (digits === '') return
                            updateScheduleTimePart(index, 'hour', Number(digits))
                          }}
                        />
                        <div className="automation-schedule-stepper-controls">
                          <button
                            type="button"
                            className="automation-schedule-stepper-button"
                            disabled={disabled}
                            aria-label={`将第 ${index + 1} 个执行时间的小时增加 1`}
                            onClick={() => updateScheduleTimePart(index, 'hour', hour + 1)}
                          >
                            <ChevronUp size={11} strokeWidth={2.4} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="automation-schedule-stepper-button"
                            disabled={disabled}
                            aria-label={`将第 ${index + 1} 个执行时间的小时减少 1`}
                            onClick={() => updateScheduleTimePart(index, 'hour', hour - 1)}
                          >
                            <ChevronDown size={11} strokeWidth={2.4} aria-hidden="true" />
                          </button>
                        </div>
                      </div>

                      <span className="automation-schedule-time-unit" aria-hidden="true">分</span>
                      <div className="automation-schedule-stepper">
                        <label htmlFor={minuteId} className="sr-only">第 {index + 1} 个执行时间的分钟</label>
                        <input
                          id={minuteId}
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={minuteDisplay}
                          disabled={disabled}
                          className="automation-schedule-stepper-input"
                          onChange={(event) => {
                            const digits = event.target.value.replace(/\D/g, '').slice(0, 2)
                            if (digits === '') return
                            updateScheduleTimePart(index, 'minute', Number(digits))
                          }}
                        />
                        <div className="automation-schedule-stepper-controls">
                          <button
                            type="button"
                            className="automation-schedule-stepper-button"
                            disabled={disabled}
                            aria-label={`将第 ${index + 1} 个执行时间的分钟增加 1`}
                            onClick={() => updateScheduleTimePart(index, 'minute', minute + 1)}
                          >
                            <ChevronUp size={11} strokeWidth={2.4} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="automation-schedule-stepper-button"
                            disabled={disabled}
                            aria-label={`将第 ${index + 1} 个执行时间的分钟减少 1`}
                            onClick={() => updateScheduleTimePart(index, 'minute', minute - 1)}
                          >
                            <ChevronDown size={11} strokeWidth={2.4} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="automation-schedule-time-enable">
                      <span className="automation-schedule-time-enable-label" aria-hidden="true">开启</span>
                      <Switch
                        checked={entry.enabled}
                        onChange={(nextEnabled) => updateScheduleTimeEnabled(index, nextEnabled)}
                        disabled={disabled}
                        label={`第 ${index + 1} 个执行时间开启`}
                        compact
                        className="automation-schedule-time-switch"
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </motion.div>
        ) : (
          <div className="automation-schedule-empty">
            <strong>定时运行已关闭</strong>
            <p>打开右上角开关后设置执行时间</p>
          </div>
        )}

        <NotificationSettings />
      </SmoothPanel>
    </div>
  )
}
