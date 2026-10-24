import React, { Activity, useState } from 'react'
import { appPages } from './pages'

interface PageErrorBoundaryProps {
  activeKey: string
  pageKey: string
  children: React.ReactNode
}

class PageErrorBoundary extends React.Component<PageErrorBoundaryProps, { hasError: boolean; errorMessage: string }> {
  constructor(props: PageErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, errorMessage: '' }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, errorMessage: error?.message || '页面渲染失败' }
  }

  componentDidCatch(error: Error) {
    console.error('Page render error:', error)
  }

  componentDidUpdate(prevProps: PageErrorBoundaryProps) {
    if (prevProps.activeKey !== this.props.activeKey && this.state.hasError) {
      this.setState({ hasError: false, errorMessage: '' })
    }
  }

  render() {
    const content = this.state.hasError ? (
        <div className="p-6">
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-900/10 dark:text-red-300">
            页面渲染失败：{this.state.errorMessage}
          </div>
        </div>
    ) : this.props.children

    return (
      <Activity
        name={`${this.props.pageKey}-workspace`}
        mode={this.props.activeKey === this.props.pageKey ? 'visible' : 'hidden'}
      >
        {content}
      </Activity>
    )
  }
}

/**
 * 保活渲染：访问过的页面持续挂载，仅切换可见性
 */
export function VisitedWorkspaces({ activeTab }: { activeTab: string }) {
  const [visitedPages] = useState(() => new Set([activeTab]))
  // The active tab prop already drives renders; keep history mutable to avoid a second render on navigation.
  visitedPages.add(activeTab)

  return appPages
    .filter(({ id }) => id === activeTab || visitedPages.has(id))
    .map(({ id, Component }) => (
      <PageErrorBoundary key={id} activeKey={activeTab} pageKey={id}>
        <Component />
      </PageErrorBoundary>
    ))
}
