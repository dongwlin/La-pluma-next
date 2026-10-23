import { usePreviewStore, type PreviewMode } from '../stores/previewStore'
import { Select } from './common/Input'

const modes: { value: PreviewMode; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'snapshot', label: '快照' },
  { value: 'live', label: '实时' },
]

export function PreviewModeSelect() {
  const mode = usePreviewStore(state => state.mode)
  const setMode = usePreviewStore(state => state.setMode)

  return (
    <Select
      aria-label="预览模式"
      value={mode}
      onChange={value => setMode(value as PreviewMode)}
      options={modes}
      className="w-24 shrink-0 text-xs"
    />
  )
}

export default function PreviewModeControls({ unavailable = false, showAutoStart = false }: { unavailable?: boolean; showAutoStart?: boolean }) {
  const mode = usePreviewStore(state => state.mode)
  const setMode = usePreviewStore(state => state.setMode)
  const autoStart = usePreviewStore(state => state.autoStart)
  const setAutoStart = usePreviewStore(state => state.setAutoStart)

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex flex-wrap gap-1" role="group" aria-label="预览模式">
        {modes.map(option => (
          <button
            key={option.value}
            type="button"
            aria-pressed={mode === option.value}
            disabled={unavailable && option.value !== 'off'}
            onClick={() => setMode(option.value)}
            className={`min-h-11 rounded-md px-3 text-xs font-medium disabled:opacity-50 ${mode === option.value ? 'control-active' : 'control-surface text-secondary'}`}
          >{option.label}</button>
        ))}
      </div>
      {showAutoStart && (
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-secondary">
          <input type="checkbox" checked={autoStart} onChange={event => setAutoStart(event.target.checked)} />
          重新打开时恢复预览
        </label>
      )}
    </div>
  )
}
