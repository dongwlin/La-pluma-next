import { Card, CardContent } from '@/shared/ui/card'
import { Separator } from '@/shared/ui/separator'
import AutoUpdateConfigPanel from './AutoUpdateConfigPanel'
import ComponentUpdatePanel from './ComponentUpdatePanel'

export default function SettingsUpdatesPanel() {
  return (
    <Card>
      <CardContent className="app-stack-card">
        <AutoUpdateConfigPanel />
        <Separator />
        <ComponentUpdatePanel />
      </CardContent>
    </Card>
  )
}
