import { BrowserRouter } from 'react-router'
import Layout from './layout/Layout'
import PWAInstallPrompt from './layout/PWAInstallPrompt'
import { AppProviders } from './providers'
import { AppRoutes } from './router'
import { routerBasename, useActiveAppTab } from '@/shared/navigation'
import { useBackendStatusMonitor, useRunStatusProjection } from '@/features/runtime-status'
import { useExecutionObservation } from '@/features/task-execution'
import { PreviewSessionProvider } from '@/features/device-mirror'

function AppShell() {
  useExecutionObservation()
  useRunStatusProjection()
  useBackendStatusMonitor()
  const activeTab = useActiveAppTab()

  return (
    <PreviewSessionProvider>
      <Layout activeTab={activeTab}>
        <AppRoutes activeTab={activeTab} />
      </Layout>
      <PWAInstallPrompt />
    </PreviewSessionProvider>
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
