import React, { Activity, useState, useEffect } from 'react'
import { MotionConfig } from 'framer-motion'
import Dashboard from './components/Dashboard'
import AutomationTasks from './components/AutomationTasks'
import CombatTasks from './components/CombatTasks'
import RoguelikeTasks from './components/RoguelikeTasks'
import OperatorTraining from './components/OperatorTraining'
import LogViewer from './components/LogViewer'
import DataStatistics from './components/DataStatistics'
import ConfigManager from './components/ConfigManager'
import Layout from './components/Layout'
import PWAInstallPrompt from './components/PWAInstallPrompt'
import { useBackendStatusMonitor } from './hooks/useBackendStatusMonitor'
import { useUIStore } from '@/shared/stores'

const appPages = [
  { id: 'dashboard', Component: Dashboard },
  { id: 'automation', Component: AutomationTasks },
  { id: 'combat', Component: CombatTasks },
  { id: 'roguelike', Component: RoguelikeTasks },
  { id: 'training', Component: OperatorTraining },
  { id: 'logs', Component: LogViewer },
  { id: 'statistics', Component: DataStatistics },
  { id: 'config', Component: ConfigManager },
] as const

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

function VisitedWorkspaces({ activeTab }: { activeTab: string }) {
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

function App() {
  useBackendStatusMonitor()
  const theme = useUIStore(state => state.theme)
  const isDark = theme === 'dark'
    || (theme === 'system' && typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)

  useEffect(() => {
    document.getElementById('app-root')?.classList.toggle('dark', isDark)
  }, [isDark])

  return (
    <div id="app-root" className="la-pluma-app">
      <MotionConfig reducedMotion="user">
        <Layout>
          {({ activeTab }) => <VisitedWorkspaces activeTab={activeTab} />}
        </Layout>
        <PWAInstallPrompt />
      </MotionConfig>
    </div>
  )
}

export default App
