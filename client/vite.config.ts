import { defineConfig, loadEnv } from 'vite'
import type { HtmlTagDescriptor, Plugin, UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import type { ManifestOptions } from 'vite-plugin-pwa'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOOT_THEME_COLORS, createBootScript } from './src/shared/theme/bootTheme.ts'

// ES 模块中获取 __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const normalizeBasePath = (value = '/') => {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '/') return '/'

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return `${withLeadingSlash.replace(/\/+$/, '')}/`
}

export const createNavigateFallbackDenylist = (basePath: string): RegExp[] => {
  const denylist = [
    /^\/api(?:[/?]|$)/,
    /^\/health(?:[/?]|$)/,
    /^\/webrtc-signaling(?:[/?]|$)/,
  ]

  if (basePath !== '/') {
    const escapedBasePath = basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    denylist.push(new RegExp(`^${escapedBasePath}(?:api|health|webrtc-signaling)(?:[/?]|$)`))
  }

  return denylist
}

export interface WorkboxConfig {
  cleanupOutdatedCaches: boolean
  // All app code ships in the statically imported entry chunks, so this glob
  // precaches every JS asset and the app stays fully usable offline.
  globPatterns: string[]
  navigateFallbackDenylist: RegExp[]
  importScripts: string[]
}

export const createWorkboxConfig = (basePath: string): WorkboxConfig => ({
  cleanupOutdatedCaches: true,
  globPatterns: [
    '**/*.{css,html,ico,png,svg,woff,woff2}',
    'assets/{index,react-vendor,motion-vendor,workbox-window.prod.es5}-*.js',
  ],
  navigateFallbackDenylist: createNavigateFallbackDenylist(basePath),
  importScripts: [`${basePath}legacy-page-cache-cleanup.js`],
})

export const createDevServiceWorkerCleanupScript = () => `
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys()
    const appCacheNames = cacheNames.filter((cacheName) =>
      cacheName.startsWith('workbox-')
      || cacheName === 'google-fonts-cache'
      || cacheName === 'la-pluma-page-chunks')
    await Promise.all(appCacheNames.map((cacheName) => caches.delete(cacheName)))

    await self.clients.claim()
    const windowClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    })
    await self.registration.unregister()
    await Promise.all(windowClients.map(async (client) => {
      try {
        await client.navigate(client.url)
      } catch {
        // A closed client does not need to be refreshed.
      }
    }))
  })())
})
`.trimStart()

export const createWebManifest = (basePath: string): Partial<ManifestOptions> => ({
  name: 'La Pluma Next - MAA WebUI',
  short_name: 'La Pluma Next',
  description: 'MAA CLI 的现代化 Web 界面',
  lang: 'zh-CN',
  theme_color: BOOT_THEME_COLORS.dark.themeColor,
  // 启动画面底色，与浏览器 chrome 的 theme-color 是两种语义，保持独立。
  background_color: '#05090c',
  display: 'standalone',
  scope: basePath,
  start_url: basePath,
  icons: [
    {
      src: 'pwa-graphite-192x192.png',
      sizes: '192x192',
      type: 'image/png'
    },
    {
      src: 'pwa-graphite-512x512.png',
      sizes: '512x512',
      type: 'image/png'
    },
    {
      src: 'pwa-maskable-512x512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable'
    }
  ]
})

/**
 * dev 中间件只使用 request 的 method/url 和 response 的最小写入面，按结构声明，
 * 测试即可直接构造替身，不必伪造整个 ViteDevServer。
 */
export interface DevPwaMiddlewareRequest {
  method?: string
  url?: string
}

export interface DevPwaMiddlewareResponse {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

export type DevPwaMiddleware = (
  request: DevPwaMiddlewareRequest,
  response: DevPwaMiddlewareResponse,
  next: () => void,
) => void

export const createDevPwaMiddleware = (basePath: string): DevPwaMiddleware => {
  const serviceWorkerPath = `${basePath}sw.js`
  const manifestPath = `${basePath}manifest.webmanifest`
  const cleanupScript = createDevServiceWorkerCleanupScript()
  const manifest = createWebManifest(basePath)

  return (request, response, next) => {
    const requestUrl = new URL(request.url || '/', 'http://localhost')
    if (requestUrl.pathname === manifestPath) {
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/manifest+json; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(manifest))
      return
    }
    if (requestUrl.pathname !== serviceWorkerPath) {
      next()
      return
    }

    response.statusCode = 200
    response.setHeader('Content-Type', 'application/javascript; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
    response.setHeader('Service-Worker-Allowed', basePath)
    response.setHeader('X-La-Pluma-Dev-Service-Worker', 'cleanup')
    response.end(request.method === 'HEAD' ? undefined : cleanupScript)
  }
}

export const createManifestLinkTag = (basePath: string): HtmlTagDescriptor => ({
  tag: 'link',
  attrs: { rel: 'manifest', href: `${basePath}manifest.webmanifest` },
  injectTo: 'head',
})

export const createDevPwaSupportPlugin = (basePath: string): Plugin => ({
  name: 'la-pluma-dev-pwa-support',
  apply: 'serve',
  transformIndexHtml() {
    return [createManifestLinkTag(basePath)]
  },
  configureServer(server) {
    server.middlewares.use(createDevPwaMiddleware(basePath))
  }
})

/**
 * 把首帧主题 meta 与脚本依次注入 index.html 的 head 末尾（dev 与 build 都生效）。
 * 用 'head' 而不是 'head-prepend'：同一 injectTo 下按数组顺序输出，因此两个
 * meta 必然排在脚本之前，applyTheme 首次运行才能覆写它们。
 * 初始值取深色：<html> 静态就是 class="dark"，index.html 的默认主题也是深色；
 * 脚本随后按 localStorage 中的偏好改写。meta content 与脚本内容都由
 * shared/theme/bootTheme.ts 单一生成，index.html 里不再内联副本。
 */
export const createBootThemeTags = (): HtmlTagDescriptor[] => [
  {
    tag: 'meta',
    attrs: { name: 'theme-color', content: BOOT_THEME_COLORS.dark.themeColor },
    injectTo: 'head',
  },
  {
    tag: 'meta',
    attrs: { name: 'apple-mobile-web-app-status-bar-style', content: BOOT_THEME_COLORS.dark.statusBar },
    injectTo: 'head',
  },
  {
    tag: 'script',
    children: createBootScript(),
    injectTo: 'head',
  },
]

export const createBootAssetsPlugin = (): Plugin => ({
  name: 'la-pluma-boot-assets',
  transformIndexHtml() {
    return createBootThemeTags()
  },
})

// https://vite.dev/config/
export const createViteConfig = (basePath: string): UserConfig => ({
  base: basePath,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  plugins: [
    createDevPwaSupportPlugin(basePath),
    createBootAssetsPlugin(),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: {
        enabled: false // 开发模式下禁用 Service Worker
      },
      includeAssets: ['favicon-graphite.png', 'apple-touch-icon-graphite.png'],
      manifest: createWebManifest(basePath),
      workbox: createWorkboxConfig(basePath)
    })
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react-vendor'
          if (/node_modules\/(framer-motion|motion-dom|motion-utils)\//.test(id)) return 'motion-vendor'
          return undefined
        }
      }
    }
  },
  server: {
    host: '0.0.0.0', // 监听所有网络接口，允许局域网访问
    port: 5173,
    strictPort: false, // 如果端口被占用，自动尝试下一个可用端口
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/webrtc-signaling': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      }
    }
  }
})

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname)
  return createViteConfig(normalizeBasePath(env.VITE_BASE_PATH))
})
