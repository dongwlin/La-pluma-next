import { Card } from '@/shared/ui/card'
import AutoUpdateConfigPanel from './AutoUpdateConfigPanel'
import ComponentUpdatePanel from './ComponentUpdatePanel'

export default function SettingsUpdatesPanel() {
  return (
    <Card className="gap-3.5 px-(--card-spacing)">
      <AutoUpdateConfigPanel />
      <ComponentUpdatePanel />
    </Card>
  )
}
