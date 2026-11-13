import type { ReactNode } from 'react'

export function DetailField({
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

export function DetailSection({
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
