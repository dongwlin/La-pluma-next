import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import AutoUpdateConfigPanel from './AutoUpdateConfigPanel'
import ComponentUpdatePanel from './ComponentUpdatePanel'

export default function SettingsUpdatesPanel() {
  return (
    <Card>
      <CardHeader className="border-b py-3.5">
        <CardTitle role="heading" aria-level={2}>组件更新</CardTitle>
      </CardHeader>
      <CardContent className="app-stack-card">
        <AutoUpdateConfigPanel />
        <ComponentUpdatePanel />
      </CardContent>
    </Card>
  )
}
