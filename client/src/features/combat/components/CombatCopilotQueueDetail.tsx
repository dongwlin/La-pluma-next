import { Copy } from 'lucide-react'
import { useStatusStore } from '@/features/runtime-status'
import { Button } from '@/shared/ui'
import { formatCopilotApCost } from '../model/copilotPayload'

export interface CombatCopilotQueueDetailItem {
  id?: number | string
  name?: string
  stage?: string
  apCost?: number | null
  presetFormation?: boolean
  operators?: string
  uri?: string
}

interface CombatCopilotQueueDetailProps {
  detailId: string
  item: CombatCopilotQueueDetailItem
}

export default function CombatCopilotQueueDetail({
  detailId,
  item,
}: CombatCopilotQueueDetailProps) {
  const setStatusMessage = useStatusStore(state => state.setMessage)
  const uri = item.uri ?? (item.id !== undefined ? `prts://${item.id}` : undefined)
  const title = item.name || (item.id !== undefined ? `作业 #${item.id}` : '作业')

  const handleCopy = async () => {
    if (!uri) return
    try {
      await navigator.clipboard.writeText(uri)
      setStatusMessage('已复制作业链接', 'success')
    } catch {
      setStatusMessage('复制失败，请手动选择链接', 'error')
    }
  }

  return (
    <div id={detailId} className="combat-copilot-detail">
      <dl className="combat-copilot-detail-grid">
        <div className="combat-copilot-detail-field">
          <dt className="combat-copilot-detail-label">作业</dt>
          <dd className="combat-copilot-detail-value">{title}</dd>
        </div>
        <div className="combat-copilot-detail-field">
          <dt className="combat-copilot-detail-label">关卡</dt>
          <dd className="combat-copilot-detail-value">{item.stage || '未知'}</dd>
        </div>
        <div className="combat-copilot-detail-field">
          <dt className="combat-copilot-detail-label">理智</dt>
          <dd className="combat-copilot-detail-value">{formatCopilotApCost(item.apCost)}</dd>
        </div>
        <div className="combat-copilot-detail-field">
          <dt className="combat-copilot-detail-label">编队</dt>
          <dd className="combat-copilot-detail-value">
            {item.presetFormation ? '预设编队 · 仅普通' : '按执行设置自动编队'}
          </dd>
        </div>
        {item.operators && (
          <div className="combat-copilot-detail-field combat-copilot-detail-wide">
            <dt className="combat-copilot-detail-label">干员</dt>
            <dd className="combat-copilot-detail-value">{item.operators}</dd>
          </div>
        )}
        {uri && (
          <div className="combat-copilot-detail-field combat-copilot-detail-wide">
            <dt className="combat-copilot-detail-label">作业链接</dt>
            <dd className="combat-copilot-detail-value combat-copilot-detail-link">
              <code>{uri}</code>
              <Button
                onClick={() => void handleCopy()}
                variant="ghost"
                size="sm"
                className="min-h-11 shrink-0"
                icon={<Copy size={14} aria-hidden="true" />}
              >
                复制链接
              </Button>
            </dd>
          </div>
        )}
      </dl>
    </div>
  )
}
