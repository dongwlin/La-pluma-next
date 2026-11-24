import { LoaderCircle, Search } from 'lucide-react'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/shared/ui/item'
import { EmptyState } from '@/shared/components'
import SettingsFeedback from './SettingsFeedback'
import { useSettingsDeviceConnection } from '../hooks/useSettingsDeviceConnection'
import type { DiscoveredDevice } from '../model/deviceConnection'

export interface DeviceConnectionPanelProps {
  /** 点击时取最新草稿，而不是面板挂载时的副本。 */
  readonly adbPath: string
  readonly address: string
  /** 首次读取被采纳前不写入草稿，选择设备入口保持禁用。 */
  readonly disabled?: boolean
}

const deviceStateLabel = (device: DiscoveredDevice): string => {
  switch (device.state) {
    case 'device':
      return '已连接'
    case 'candidate':
      return '可尝试连接'
    case 'offline':
      return '设备离线'
    case 'unauthorized':
      return '等待授权'
    default:
      return '状态未知'
  }
}

const deviceStateClass = (device: DiscoveredDevice): string => {
  switch (device.state) {
    case 'device':
      return 'status-success'
    case 'candidate':
      return 'status-info'
    case 'offline':
    case 'unauthorized':
      return 'status-warning'
    default:
      return 'text-muted-foreground'
  }
}

export default function DeviceConnectionPanel({
  adbPath,
  address,
  disabled = false,
}: DeviceConnectionPanelProps) {
  const {
    discovery: deviceDiscovery,
    test: connectionTest,
    discover: discoverDevices,
    testConnection,
    selectDevice: selectDiscoveredDevice,
  } = useSettingsDeviceConnection()
  const discoveredDevices = deviceDiscovery.devices
  const discoveryMessage = deviceDiscovery.message
  const hasSearchedDevices = deviceDiscovery.searched
  const discoveringDevices = deviceDiscovery.phase === 'running'
  const testingConnection = connectionTest.phase === 'running'
  const connectionFeedback = connectionTest.message
    ? { success: connectionTest.success, message: connectionTest.message }
    : null

  const handleUseDiscoveredDevice = (device: DiscoveredDevice) => {
    selectDiscoveredDevice(device)
  }

  return (
    <section className="min-w-0" aria-label="模拟器查找与连接测试">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-3.5">
        <div className="min-w-0">
          <h3 className="text-sm font-medium whitespace-nowrap text-foreground">模拟器连接</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled || discoveringDevices}
            aria-busy={discoveringDevices || undefined}
            onClick={() => void discoverDevices(adbPath)}
            className="shrink-0"
          >
            {discoveringDevices
              ? <><LoaderCircle className="animate-spin" aria-hidden="true" />查找中</>
              : '查找模拟器'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || testingConnection}
            aria-busy={testingConnection || undefined}
            onClick={() => void testConnection(adbPath, address)}
            className="shrink-0"
          >
            {testingConnection
              ? <><LoaderCircle className="animate-spin" aria-hidden="true" />测试中</>
              : '测试连接'}
          </Button>
        </div>
      </div>

      {discoveryMessage && (
        <p className="mt-3 text-xs text-muted-foreground" role="status">{discoveryMessage}</p>
      )}

      {discoveredDevices.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-lg border border-border">
          {discoveredDevices.map(device => {
            const selectable = device.state === 'device' || device.state === 'candidate'
            return (
              <Item
                key={`${device.source}-${device.address}`}
                render={(
                  <button
                    type="button"
                    disabled={disabled || !selectable || testingConnection}
                    onClick={() => void handleUseDiscoveredDevice(device)}
                  />
                )}
                className="min-h-12 rounded-none border-0 border-b border-border px-3 py-2.5 text-left last:border-b-0 hover:bg-muted/60 focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ItemContent className="min-w-0">
                  <ItemTitle className="block w-full truncate">{device.address}</ItemTitle>
                  <ItemDescription className="line-clamp-1 text-xs">
                    {device.details || (device.source === 'adb'
                      ? 'ADB 已识别设备'
                      : device.source === 'emulator-adb'
                        ? '模拟器内置 ADB'
                        : '本机端口')}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Badge variant="ghost" className={deviceStateClass(device)}>
                    {deviceStateLabel(device)}
                  </Badge>
                </ItemActions>
              </Item>
            )
          })}
        </div>
      )}

      {hasSearchedDevices && !discoveredDevices.length && (
        <EmptyState
          compact
          className="mt-3"
          icon={<Search className="h-5 w-5" aria-hidden="true" />}
          title="未找到已连接设备"
        />
      )}

      {connectionFeedback && (
        <SettingsFeedback
          tone={connectionFeedback.success ? 'success' : 'error'}
          message={connectionFeedback.message}
          className="mt-3"
        />
      )}
    </section>
  )
}
