import Layout from './layout/Layout'
import PWAInstallPrompt from './layout/PWAInstallPrompt'
import { AppProviders } from './providers'
import { VisitedWorkspaces } from './router'
import { useBackendStatusMonitor } from '@/features/runtime-status'

function App() {
  useBackendStatusMonitor()

  return (
    <div id="app-root" className="la-pluma-app">
      <AppProviders>
        <Layout>
          {({ activeTab }) => <VisitedWorkspaces activeTab={activeTab} />}
        </Layout>
        <PWAInstallPrompt />
      </AppProviders>
    </div>
  )
}

export default App
