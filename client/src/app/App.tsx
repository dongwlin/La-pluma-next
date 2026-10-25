import { BrowserRouter } from 'react-router'
import Layout from './layout/Layout'
import PWAInstallPrompt from './layout/PWAInstallPrompt'
import { AppProviders } from './providers'
import { AppRoutes } from './router'
import { routerBasename, useActiveAppTab } from '@/shared/navigation'
import { useBackendStatusMonitor } from '@/features/runtime-status'
import { useExecutionObservation } from '@/features/task-execution'

function AppShell() {
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
  useBackendStatusMonitor()
  useExecutionObservation()

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
