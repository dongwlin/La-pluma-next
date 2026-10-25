import { BrowserRouter } from 'react-router'
import Layout from './layout/Layout'
import PWAInstallPrompt from './layout/PWAInstallPrompt'
import { AppProviders } from './providers'
import { AppRoutes } from './router'
import { routerBasename, useActiveAppTab } from '@/shared/navigation'
import { useBackendStatusMonitor, useRunStatusProjection } from '@/features/runtime-status'
import { useExecutionObservation } from '@/features/task-execution'

function AppShell() {
  // 应用级观察/投影/探针必须位于 AppProviders 内，后续接入 Query 时才能拿到客户端。
  useExecutionObservation()
  useRunStatusProjection()
  useBackendStatusMonitor()
  const activeTab = useActiveAppTab()

  return (
    <>
      <Layout activeTab={activeTab}>
        <AppRoutes activeTab={activeTab} />
      </Layout>
      <PWAInstallPrompt />
    </>
  )
}

function App() {
  return (
    <div id="app-root" className="la-pluma-app">
      <BrowserRouter basename={routerBasename() || undefined}>
        <AppProviders>
          <AppShell />
        </AppProviders>
      </BrowserRouter>
    </div>
  )
}

export default App
