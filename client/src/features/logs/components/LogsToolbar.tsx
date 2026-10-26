/**
 * 日志工具栏
 *
 * 自动滚动、折叠重复、级别、搜索与命令按钮全部是受控视图：状态由工作区
 * 持有，本组件只渲染控件并回调。暂停/继续只在实时模式出现，暂停针对实时
 * 轮询而不是历史读取；按钮的可访问名称随动作在“暂停实时日志/继续实时
 * 日志”之间切换。
 */

import { Download, Pause, Play, Search, Trash2 } from 'lucide-react'
import { Button, Card, CardContent, Input, Select, Switch } from '@/shared/ui'
import type { LogFilter } from '../model/logModel'

interface LogsToolbarProps {
  readonly autoScroll: boolean
  readonly onAutoScrollChange: (value: boolean) => void
  readonly collapseRepeats: boolean
  readonly onCollapseRepeatsChange: (value: boolean) => void
  readonly filter: LogFilter
  readonly onFilterChange: (filter: LogFilter) => void
  readonly search: string
  readonly onSearchChange: (value: string) => void
  readonly viewingHistory: boolean
  readonly paused: boolean
  readonly onTogglePause: () => void
  readonly actionBusy: boolean
  readonly canExport: boolean
  readonly onClear: () => void
  readonly onExport: () => void
}

export default function LogsToolbar({
  autoScroll,
  onAutoScrollChange,
  collapseRepeats,
  onCollapseRepeatsChange,
  filter,
  onFilterChange,
  search,
  onSearchChange,
  viewingHistory,
  paused,
  onTogglePause,
  actionBusy,
  canExport,
  onClear,
  onExport,
}: LogsToolbarProps) {
  return (
    <Card className="log-card log-toolbar-card p-0!" smoothCorners>
      <CardContent className="log-toolbar">
        <div className="log-toolbar-controls">
          <div className={`log-toggle-control flex min-h-11 min-w-0 items-center justify-between gap-3 ${viewingHistory ? 'opacity-50' : ''}`}>
            <span className="truncate text-xs font-medium text-secondary">自动滚动</span>
            <Switch
              compact
              checked={autoScroll}
              onChange={onAutoScrollChange}
              label="自动滚动"
              disabled={viewingHistory}
            />
          </div>
          <div className="log-toggle-control flex min-h-11 min-w-0 items-center justify-between gap-3">
            <span className="truncate text-xs font-medium text-secondary">折叠重复</span>
            <Switch
              compact
              checked={collapseRepeats}
              onChange={onCollapseRepeatsChange}
              label="折叠重复日志"
            />
          </div>
          <Select
            value={filter}
            onChange={value => onFilterChange(value as LogFilter)}
            aria-label="日志级别"
            className="col-span-2 w-full sm:col-auto sm:w-36"
            options={[
              { value: 'all', label: '全部级别' },
              { value: 'ERROR', label: '错误' },
              { value: 'WARN', label: '警告' },
              { value: 'INFO', label: '信息' },
              { value: 'DEBUG', label: '调试' },
            ]}
          />
          <Input
            value={search}
            onChange={onSearchChange}
            placeholder="搜索日志内容"
            aria-label="搜索日志内容"
            icon={<Search className="h-4 w-4" aria-hidden="true" />}
            className="col-span-2 w-full sm:col-auto sm:min-w-56 sm:flex-1"
          />
        </div>
        <div className="log-toolbar-actions">
          {!viewingHistory && (
            <Button
              onClick={onTogglePause}
              variant="outline"
              size="sm"
              icon={paused
                ? <Play className="h-4 w-4" aria-hidden="true" />
                : <Pause className="h-4 w-4" aria-hidden="true" />}
              disabled={actionBusy}
              aria-label={paused ? '继续实时日志' : '暂停实时日志'}
            >
              {paused ? '继续' : '暂停'}
            </Button>
          )}
          {!viewingHistory && (
            <Button
              onClick={onClear}
              variant="outline"
              size="sm"
              icon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
              disabled={actionBusy}
            >
              清空
            </Button>
          )}
          <Button
            onClick={onExport}
            variant="primary"
            size="sm"
            icon={<Download className="h-4 w-4" aria-hidden="true" />}
            disabled={!canExport}
          >
            导出
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
