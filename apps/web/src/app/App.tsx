import { BrowserRouter, useLocation } from 'react-router'
import Layout from './layout/Layout'
import PWAInstallPrompt from './layout/PWAInstallPrompt'
import { AppProviders } from './providers'
import { AppRoutes } from './router'
import ThemeGalleryPage from '@/pages/dev/ThemeGalleryPage'
import { isDevRoutePathname, routerBasename, useActiveAppTab } from '@/shared/navigation'
import { useBackendStatusMonitor, useRunStatusProjection } from '@/features/runtime-status'
import { useExecutionObservation } from '@/features/task-execution'
import { PreviewSessionProvider } from '@/features/device-mirror'

function AppShell() {
  // 应用级观察/投影/探针必须位于 AppProviders 内，后续接入 Query 时才能拿到客户端。
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

function AppSurface() {
  const { pathname } = useLocation()

  // dev 画布零 API 依赖：绕开 AppShell 的应用级观察轮询，也不带 Layout 导航 chrome。
  if (isDevRoutePathname(pathname)) {
    return <ThemeGalleryPage />
  }

  return <AppShell />
}

function App() {
  return (
    <div id="app-root" className="la-pluma-app">
      <BrowserRouter basename={routerBasename() || undefined}>
        <AppProviders>
          <AppSurface />
        </AppProviders>
      </BrowserRouter>
    </div>
  )
}

export default App
