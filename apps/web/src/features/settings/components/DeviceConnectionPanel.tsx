import { Cable, LoaderCircle, Search } from 'lucide-react'
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
  /** 选择设备会更新 connection 草稿，先清掉连接表单的旧保存/读取反馈。 */
  readonly onSelectDeviceStart: () => void
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
  onSelectDeviceStart,
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
    onSelectDeviceStart()
    selectDiscoveredDevice(device)
  }

  return (
    <section className="min-w-0" aria-label="模拟器查找与连接测试">
      <div className="flex flex-wrap items-start justify-between gap-3.5">
        <div className="flex min-w-0 items-start gap-3.5">
          <Cable size={18} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">模拟器连接</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">查找本机模拟器，或测试当前连接地址。</p>
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled || discoveringDevices}
            aria-busy={discoveringDevices || undefined}
            onClick={() => void discoverDevices(adbPath)}
            className="flex-1 sm:flex-none"
          >
            {discoveringDevices
              ? <><LoaderCircle className="animate-spin" aria-hidden="true" />查找中</>
              : (
                <>
                  <Search size={16} aria-hidden="true" />
                  查找模拟器
                </>
              )}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || testingConnection}
            aria-busy={testingConnection || undefined}
            onClick={() => void testConnection(adbPath, address)}
            className="flex-1 sm:flex-none"
          >
            {testingConnection
              ? <><LoaderCircle className="animate-spin" aria-hidden="true" />测试中</>
              : (
                <>
                  <Cable size={16} aria-hidden="true" />
                  测试连接
                </>
              )}
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
          description="启动模拟器后重新查找，或手动填写连接地址。"
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
