/**
 * 组件更新卡片容器
 *
 * 自动更新策略与 core/CLI/资源更新是两个独立用例：两个子面板各自订阅
 * 自己的 owner/Query，卡片只提供共享标题与 0 间距内容布局。
 */

import { Card, CardContent, CardHeader } from '@/shared/ui'
import AutoUpdateConfigPanel from './AutoUpdateConfigPanel'
import ComponentUpdatePanel from './ComponentUpdatePanel'

export default function SettingsUpdatesPanel() {
  return (
    <Card smoothCorners className="config-update-card p-0!">
      <CardHeader title="组件更新" />
      <CardContent className="app-stack-card">
        <AutoUpdateConfigPanel />
        <ComponentUpdatePanel />
      </CardContent>
    </Card>
  )
}
