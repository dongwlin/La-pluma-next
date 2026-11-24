import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Button } from '@/shared/ui/button'
import { Separator } from '@/shared/ui/separator'
import { Switch } from '@/shared/ui/switch'
import { ConfigFieldCheckbox, ConfigFieldInput } from './ConfigFieldControls'
import SettingsFeedback from './SettingsFeedback'
import { notify } from '@/shared/notifications'
import { INVALID_UPDATE_TIME_MESSAGE } from '../model/autoUpdateConfig'
import { useSettingsAutoUpdate } from '../hooks/useSettingsAutoUpdate'
import type { AutoUpdateConfig } from '../types'

export default function AutoUpdateConfigPanel() {
  const shouldReduceMotion = useReducedMotion()
  const {
    draft: autoUpdate,
    feedback: autoUpdateFeedback,
    update: updateAutoUpdate,
    flush,
    retrySave,
  } = useSettingsAutoUpdate(notify)

  const applyUpdate = (patch: Partial<AutoUpdateConfig>) => {
    updateAutoUpdate(patch)
    flush()
  }
  const errorMessage = autoUpdateFeedback?.type === 'error'
    && autoUpdateFeedback.message !== INVALID_UPDATE_TIME_MESSAGE
    ? autoUpdateFeedback.message
    : null
  const canRetrySave = errorMessage !== null && !errorMessage.startsWith('自动更新设置读取失败')

  return (
    <section className="min-w-0" onBlur={flush}>
      <div className="flex items-center justify-between gap-3.5">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">自动更新</h3>
        </div>
        <Switch
          checked={autoUpdate.enabled}
          onCheckedChange={checked => applyUpdate({ enabled: checked })}
          aria-label="启用自动更新"
        />
      </div>

      <AnimatePresence initial={false}>
        {autoUpdate.enabled && (
          <motion.div
            initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: shouldReduceMotion ? 0.12 : 0.2 }}
          >
            <Separator className="mt-3.5" />
            <div className="mt-3.5 grid gap-3.5 md:grid-cols-[12rem_minmax(0,1fr)] md:items-end xl:grid-cols-1 xl:items-stretch">
              <ConfigFieldInput
                id="auto-update-time"
                type="text"
                label="更新时间"
                value={autoUpdate.time}
                onChange={event => updateAutoUpdate({ time: event.target.value })}
                placeholder="HH:MM"
                className="max-w-48"
              />
              <div className="flex min-h-11 flex-wrap items-center gap-x-4.5 gap-y-2">
                <ConfigFieldCheckbox
                  checked={autoUpdate.updateCore}
                  onCheckedChange={(checked: boolean) => applyUpdate({ updateCore: checked })}
                  label="更新 MaaCore"
                />
                <ConfigFieldCheckbox
                  checked={autoUpdate.updateCli}
                  onCheckedChange={(checked: boolean) => applyUpdate({ updateCli: checked })}
                  label="更新 MAA CLI"
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {errorMessage && (
        <SettingsFeedback
          tone="error"
          message={errorMessage}
          action={canRetrySave
            ? (
                <Button
                  type="button"
                  onClick={retrySave}
                  variant="outline"
                  size="sm"
                >
                  重试保存
                </Button>
              )
            : undefined}
          className="mt-3.5"
        />
      )}
    </section>
  )
}
