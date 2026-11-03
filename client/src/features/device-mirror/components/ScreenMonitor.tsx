import ScrcpyDeviceView from './ScrcpyDeviceView'
import { usePreviewSessionContext } from '../hooks/previewSessionContext'

interface ScreenMonitorProps {
  variant?: 'full' | 'compact'
}

export default function ScreenMonitor({ variant = 'full' }: ScreenMonitorProps) {
  const { infrastructure } = usePreviewSessionContext()
  return (
    <div className="scrcpy-device-container">
      <ScrcpyDeviceView
        variant={variant}
        enabled={!!infrastructure.view.infrastructureStatus?.serverRunning}
        {...infrastructure.view}
      />
    </div>
  )
}
