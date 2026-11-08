import { Copy, X } from 'lucide-react'
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Button, IconButton } from '@/shared/ui'
import { Modal } from '@/shared/ui/Modal'
import { useStatusStore } from '@/features/runtime-status'
import type { CopilotDetailOperator, CopilotDetailTarget } from '../model/copilotDetail'

export const COPILOT_DETAIL_LAYER_ID = 'combat-copilot-detail-panel'

const MOBILE_DETAIL_QUERY = '(max-width: 40rem)'

export interface CombatCopilotDetailLayerProps {
  target: CopilotDetailTarget | null
  onClose: () => void
}

function useMobileDetailLayout(): boolean {
  const [isMobile, setIsMobile] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(MOBILE_DETAIL_QUERY).matches
      : false
  ))

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(MOBILE_DETAIL_QUERY)
    const update = () => setIsMobile(query.matches)
    update()
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])

  return isMobile
}

function groupOperators(
  operators: readonly CopilotDetailOperator[],
): Array<[string, CopilotDetailOperator[]]> {
  const grouped = new Map<string, CopilotDetailOperator[]>()
  for (const operator of operators) {
    const key = operator.group?.trim() ?? ''
    const list = grouped.get(key)
    if (list) list.push(operator)
    else grouped.set(key, [operator])
  }
  return [...grouped.entries()]
}

function requirementLabels(operator: CopilotDetailOperator): string[] {
  const labels: string[] = []
  if (typeof operator.elite === 'number') labels.push(`精英 ${operator.elite}`)
  if (typeof operator.level === 'number') labels.push(`等级 ${operator.level}`)
  if (typeof operator.skillLevel === 'number') labels.push(`技能 ${operator.skillLevel}`)
  if (operator.module) labels.push(`模组 ${operator.module}`)
  return labels
}

function DetailField({
  label,
  children,
  wide = false,
}: {
  label: string
  children: ReactNode
  wide?: boolean
}) {
  return (
    <div className={`combat-copilot-detail-field${wide ? ' combat-copilot-detail-wide' : ''}`}>
      <dt className="combat-copilot-detail-label">{label}</dt>
      <dd className="combat-copilot-detail-value">{children}</dd>
    </div>
  )
}

function DetailSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="combat-copilot-detail-section">
      <h3 className="combat-copilot-detail-section-title">{title}</h3>
      {children}
    </section>
  )
}

function DetailBody({ target }: { target: CopilotDetailTarget }) {
  const setStatusMessage = useStatusStore(state => state.setMessage)
  const operators = target.operators ?? []
  const groups = target.groups ?? []
  const groupedOperators = groupOperators(operators)
  const stageLabel = target.stage ?? target.stageId

  const handleCopy = async () => {
    if (!target.uri) return
    try {
      await navigator.clipboard.writeText(target.uri)
      setStatusMessage('已复制作业链接', 'success')
    } catch {
      setStatusMessage('复制失败，请手动选择链接', 'error')
    }
  }

  return (
    <div className="combat-copilot-detail-content">
      {target.statusLabel && (
        <span className="combat-copilot-detail-state">{target.statusLabel}</span>
      )}

      <dl className="combat-copilot-detail-grid">
        {stageLabel && (
          <DetailField label="关卡">
            <span>{stageLabel}</span>
            {target.stageId && target.stageId !== stageLabel && (
              <code className="combat-copilot-detail-code">{target.stageId}</code>
            )}
          </DetailField>
        )}
        {typeof target.apCost === 'number' && (
          <DetailField label="理智">{target.apCost}</DetailField>
        )}
        {target.presetFormation !== undefined && (
          <DetailField label="编队">
            {target.presetFormation ? '预设编队 · 仅普通' : '按执行设置自动编队'}
          </DetailField>
        )}
        <DetailField label="来源">{target.sourceLabel}</DetailField>
        {target.supportsRaid !== undefined && (
          <DetailField label="突袭">
            {target.supportsRaid ? '支持突袭' : '不支持突袭'}
          </DetailField>
        )}
        {target.completedModes?.length ? (
          <DetailField label="已完成模式" wide>
            <span className="combat-copilot-detail-tags">
              {target.completedModes.map(mode => (
                <span key={mode} className="combat-copilot-tag is-complete">
                  {mode === 'raid' ? '突袭已完成' : '普通已完成'}
                </span>
              ))}
            </span>
          </DetailField>
        ) : null}
        {target.uri && (
          <DetailField label="作业链接" wide>
            <span className="combat-copilot-detail-link">
              <code>{target.uri}</code>
              <Button
                onClick={() => void handleCopy()}
                variant="ghost"
                size="sm"
                className="min-h-11 shrink-0"
                icon={<Copy size={14} aria-hidden="true" />}
              >
                复制链接
              </Button>
            </span>
          </DetailField>
        )}
      </dl>

      {target.error && (
        <DetailSection title="失败原因">
          <p role="alert" className="combat-copilot-detail-error">{target.error}</p>
        </DetailSection>
      )}

      {operators.length > 0 && (
        <DetailSection title="干员需求">
          <div className="combat-copilot-detail-operators">
            {groupedOperators.map(([group, members]) => (
              <div key={group || 'fixed'} className="combat-copilot-detail-operator-group">
                {group && <h4 className="combat-copilot-detail-operator-group-name">{group}</h4>}
                <ul className="combat-copilot-detail-operator-list">
                  {members.map((operator, index) => (
                    <li key={`${operator.name}-${index}`} className="combat-copilot-detail-operator">
                      <span className="combat-copilot-detail-operator-name">{operator.name}</span>
                      <span className="combat-copilot-detail-requirements">
                        {requirementLabels(operator).map(label => (
                          <span key={label} className="combat-copilot-detail-requirement">{label}</span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </DetailSection>
      )}

      {groups.length > 0 && (
        <DetailSection title="干员组">
          <ul className="combat-copilot-detail-group-list">
            {groups.map(group => (
              <li key={group} className="combat-copilot-detail-group">{group}</li>
            ))}
          </ul>
        </DetailSection>
      )}
    </div>
  )
}

export default function CombatCopilotDetailLayer({ target, onClose }: CombatCopilotDetailLayerProps) {
  const isMobile = useMobileDetailLayout()
  const generatedId = useId().replace(/:/g, '')
  const titleId = `combat-copilot-detail-title-${generatedId}`
  const panelRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)

  const isOpen = target !== null

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!isOpen || isMobile) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panelRef.current?.focus({ preventScroll: true })
    let closing = false
    const requestClose = () => {
      if (closing) return
      closing = true
      onCloseRef.current()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      requestClose()
    }
    const handleOutsidePress = (event: MouseEvent) => {
      const panel = panelRef.current
      if (!panel || !(event.target instanceof Node)) return
      if (panel.contains(event.target)) return
      requestClose()
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('pointerdown', handleOutsidePress)
    document.addEventListener('mousedown', handleOutsidePress)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('pointerdown', handleOutsidePress)
      document.removeEventListener('mousedown', handleOutsidePress)
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [isOpen, isMobile])

  if (isMobile) {
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={target?.title}
        placement="sheet"
        dialogId={COPILOT_DETAIL_LAYER_ID}
        size="lg"
      >
        {target && <DetailBody target={target} />}
      </Modal>
    )
  }

  if (!target || typeof document === 'undefined') return null

  return createPortal(
    <div className="combat-copilot-detail-layer">
      <aside
        ref={panelRef}
        id={COPILOT_DETAIL_LAYER_ID}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="combat-copilot-detail-drawer surface-panel"
      >
        <header className="combat-copilot-detail-head">
          <h2 id={titleId} className="combat-copilot-detail-title">{target.title}</h2>
          <IconButton
            icon={<X className="h-4 w-4" aria-hidden="true" />}
            variant="ghost"
            size="sm"
            onClick={onClose}
            title="关闭详情"
            aria-label="关闭详情"
          />
        </header>
        <div className="combat-copilot-detail-scroll">
          <DetailBody target={target} />
        </div>
      </aside>
    </div>,
    document.body,
  )
}
