/**
 * 自动更新策略面板
 *
 * 草稿、本地回退与完整提交由 `AutoUpdateConfigOwner` 持有；面板只订阅
 * 自动更新状态并渲染表单/反馈，不读取版本或组件更新命令状态。
 */

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Clock3, Save } from 'lucide-react'
import {
  Button,
  Checkbox,
  Input,
  Switch,
} from '@/shared/ui'
import { useStatusStore } from '@/features/runtime-status'
import { useSettingsAutoUpdate } from '../hooks/useSettingsAutoUpdate'

export default function AutoUpdateConfigPanel() {
  const setStatusMessage = useStatusStore(state => state.setMessage)
  const shouldReduceMotion = useReducedMotion()
  const {
    draft: autoUpdate,
    dirty: autoUpdateDirty,
    saving: autoUpdateSaving,
    feedback: autoUpdateFeedback,
    update: updateAutoUpdate,
    save: saveAutoUpdateConfig,
  } = useSettingsAutoUpdate(setStatusMessage)

  const handleSaveAutoUpdate = () => {
    void saveAutoUpdateConfig()
  }

  return (
    <section className="surface-soft rounded-xl p-(--app-space-panel)">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="icon-well flex h-9 w-9 shrink-0 items-center justify-center rounded-lg brand-text">
            <Clock3 size={18} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-primary">自动更新</h3>
            <p className="mt-1 text-xs leading-5 text-tertiary">每天按设定时间更新所选组件</p>
          </div>
        </div>
        <Switch
          checked={autoUpdate.enabled}
          onChange={checked => updateAutoUpdate({ enabled: checked })}
          label="启用自动更新"
        />
      </div>

      <AnimatePresence initial={false}>
        {autoUpdate.enabled && (
          <motion.div
            initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: shouldReduceMotion ? 0.12 : 0.2 }}
            className="mt-4 grid gap-4 border-t border-(--app-border) pt-4 md:grid-cols-[12rem_minmax(0,1fr)] md:items-end xl:grid-cols-1 xl:items-stretch"
          >
            <Input
              type="text"
              label="更新时间"
              value={autoUpdate.time}
              onChange={(value: string) => updateAutoUpdate({ time: value })}
              placeholder="HH:MM"
              className="max-w-48"
            />
            <div className="flex min-h-11 flex-wrap items-center gap-x-5 gap-y-2">
              <Checkbox
                checked={autoUpdate.updateCore}
                onChange={(checked: boolean) => updateAutoUpdate({ updateCore: checked })}
                label="更新 MaaCore"
              />
              <Checkbox
                checked={autoUpdate.updateCli}
                onChange={(checked: boolean) => updateAutoUpdate({ updateCli: checked })}
                label="更新 MAA CLI"
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {autoUpdateFeedback && (
        <div
          className={`mt-4 rounded-lg px-3 py-2.5 text-xs leading-5 ${
            autoUpdateFeedback.type === 'success'
              ? 'status-success'
              : autoUpdateFeedback.type === 'warning'
                ? 'status-warning'
                : 'status-danger'
          }`}
          role={autoUpdateFeedback.type === 'error' ? 'alert' : 'status'}
        >
          {autoUpdateFeedback.message}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-(--app-border) pt-4">
        <p className="text-xs text-tertiary">{autoUpdateDirty ? '有尚未保存的更改' : '设置会在保存后生效'}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={autoUpdateSaving}
          loadingText="保存中"
          disabled={!autoUpdateDirty || autoUpdateSaving}
          onClick={handleSaveAutoUpdate}
          icon={<Save size={16} aria-hidden="true" />}
        >
          保存自动更新
        </Button>
      </div>
    </section>
  )
}
