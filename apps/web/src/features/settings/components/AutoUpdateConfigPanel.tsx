import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { LoaderCircle, Save } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { Separator } from '@/shared/ui/separator'
import { Switch } from '@/shared/ui/switch'
import { ConfigFieldCheckbox, ConfigFieldInput } from './ConfigFieldControls'
import SettingsFeedback from './SettingsFeedback'
import { notify } from '@/shared/notifications'
import { useSettingsAutoUpdate } from '../hooks/useSettingsAutoUpdate'

export default function AutoUpdateConfigPanel() {
  const shouldReduceMotion = useReducedMotion()
  const {
    draft: autoUpdate,
    dirty: autoUpdateDirty,
    saving: autoUpdateSaving,
    feedback: autoUpdateFeedback,
    update: updateAutoUpdate,
    save: saveAutoUpdateConfig,
  } = useSettingsAutoUpdate(notify)

  const handleSaveAutoUpdate = () => {
    void saveAutoUpdateConfig()
  }

  return (
    <section className="min-w-0">
      <div className="flex items-center justify-between gap-3.5">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">自动更新</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">每天按设定时间更新所选组件</p>
        </div>
        <Switch
          checked={autoUpdate.enabled}
          onCheckedChange={checked => updateAutoUpdate({ enabled: checked })}
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
                  onCheckedChange={(checked: boolean) => updateAutoUpdate({ updateCore: checked })}
                  label="更新 MaaCore"
                />
                <ConfigFieldCheckbox
                  checked={autoUpdate.updateCli}
                  onCheckedChange={(checked: boolean) => updateAutoUpdate({ updateCli: checked })}
                  label="更新 MAA CLI"
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {autoUpdateFeedback?.type === 'error' && (
        <SettingsFeedback
          tone="error"
          message={autoUpdateFeedback.message}
          className="mt-3.5"
        />
      )}

      <Separator className="my-3.5" />
      <div className="flex flex-wrap items-center justify-between gap-3.5">
        <p className="text-xs text-muted-foreground">{autoUpdateDirty ? '有尚未保存的更改' : '设置会在保存后生效'}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!autoUpdateDirty || autoUpdateSaving}
          aria-busy={autoUpdateSaving || undefined}
          onClick={handleSaveAutoUpdate}
        >
          {autoUpdateSaving
            ? <><LoaderCircle className="animate-spin" aria-hidden="true" />保存中</>
            : (
              <>
                <Save size={16} aria-hidden="true" />
                保存自动更新
              </>
            )}
        </Button>
      </div>
    </section>
  )
}
