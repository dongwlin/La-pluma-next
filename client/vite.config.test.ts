import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import {
  createBootThemeTags,
  createDevPwaMiddleware,
  createDevServiceWorkerCleanupScript,
  createManifestLinkTag,
  createNavigateFallbackDenylist,
  createWebManifest,
  createWorkboxConfig,
  normalizeBasePath,
} from './vite.config.ts'
import { BOOT_THEME_COLORS, createBootScript } from './src/shared/theme/bootTheme.ts'

/** 服务 worker 脚本通过 self.addEventListener 注册；测试只关心 waitUntil 生命周期。 */
type ServiceWorkerListener = (event: { waitUntil: (work: Promise<unknown>) => void }) => void

describe('boot theme asset injection', () => {
  it('injects the boot metas before the generated boot script at the end of the document head', () => {
    // 必须是 'head'（追加到 head 末尾）而非 'head-prepend'：同一 injectTo 下
    // 数组顺序即输出顺序，两个 meta 必须排在脚本之前，首帧 applyTheme 才能
    // 覆写它们。初始值取深色，与 index.html 静态的 class="dark" 一致。
    const tags = createBootThemeTags()

    expect(tags).toEqual([
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
    ])
  })
})

describe('PWA base path configuration', () => {
  it('normalizes a configured deployment path', () => {
    expect(normalizeBasePath()).toBe('/')
    expect(normalizeBasePath('la-pluma')).toBe('/la-pluma/')
    expect(normalizeBasePath('/la-pluma/')).toBe('/la-pluma/')
  })

  it('keeps API and signaling routes out of the navigation fallback', () => {
    const denylist = createNavigateFallbackDenylist('/la-pluma/')
    const isDenied = (url: string) => denylist.some(pattern => pattern.test(url))

    expect(isDenied('/api/agent/manifest')).toBe(true)
    expect(isDenied('/api?format=json')).toBe(true)
    expect(isDenied('/health')).toBe(true)
    expect(isDenied('/health?probe=1')).toBe(true)
    expect(isDenied('/webrtc-signaling/socket')).toBe(true)
    expect(isDenied('/webrtc-signaling?probe=1')).toBe(true)
    expect(isDenied('/la-pluma/api/agent/manifest')).toBe(true)
    expect(isDenied('/la-pluma/health?probe=1')).toBe(true)
    expect(isDenied('/la-pluma/webrtc-signaling/socket')).toBe(true)
    expect(isDenied('/la-pluma/automation')).toBe(false)
  })

  it('cleans outdated caches, loads the legacy cleanup worker and adds no runtime caching routes', () => {
    const workbox = createWorkboxConfig('/la-pluma/')

    expect(workbox.cleanupOutdatedCaches).toBe(true)
    expect(workbox.importScripts).toEqual(['/la-pluma/legacy-page-cache-cleanup.js'])
    expect('runtimeCaching' in workbox).toBe(false)
  })

  it('purges the legacy page-chunk cache when the worker activates', async () => {
    const listeners = new Map<string, ServiceWorkerListener>()
    const deleteCache = vi.fn().mockResolvedValue(true)
    runInNewContext(
      readFileSync(new URL('./public/legacy-page-cache-cleanup.js', import.meta.url), 'utf8'),
      {
        self: {
          addEventListener: (type: string, listener: ServiceWorkerListener) => listeners.set(type, listener),
        },
        caches: { delete: deleteCache },
      },
    )

    let activateWork: Promise<unknown> | undefined
    listeners.get('activate')!({
      waitUntil: (work) => {
        activateWork = work
      },
    })
    await activateWork

    expect(deleteCache).toHaveBeenCalledWith('la-pluma-page-chunks')
  })

  it('serves a no-store cleanup worker and manifest before the development SPA fallback', () => {
    const middleware = createDevPwaMiddleware('/la-pluma/')
    const request = (url: string) => {
      const headers = new Map<string, string>()
      const response = {
        statusCode: 0,
        setHeader: (name: string, value: string) => headers.set(name, value),
        end: vi.fn(),
      }
      const next = vi.fn()
      middleware({ method: 'GET', url }, response, next)
      return { headers, response, next }
    }

    const worker = request('/la-pluma/sw.js?update=1')
    expect(worker.next).not.toHaveBeenCalled()
    expect(worker.response.statusCode).toBe(200)
    expect(worker.headers.get('Cache-Control')).toContain('no-store')
    expect(worker.headers.get('Service-Worker-Allowed')).toBe('/la-pluma/')
    expect(worker.response.end).toHaveBeenCalledWith(createDevServiceWorkerCleanupScript())

    const manifest = request('/la-pluma/manifest.webmanifest')
    expect(manifest.next).not.toHaveBeenCalled()
    expect(JSON.parse(manifest.response.end.mock.calls[0]?.[0] as string)).toEqual(createWebManifest('/la-pluma/'))

    const other = request('/src/main.tsx')
    expect(other.next).toHaveBeenCalledOnce()
  })

  it('executes the cleanup worker lifecycle without touching unrelated caches', async () => {
    const listeners = new Map<string, ServiceWorkerListener>()
    const skipWaiting = vi.fn().mockResolvedValue(undefined)
    const claim = vi.fn().mockResolvedValue(undefined)
    const unregister = vi.fn().mockResolvedValue(true)
    const navigate = vi.fn().mockResolvedValue(undefined)
    const deleteCache = vi.fn().mockResolvedValue(true)

    runInNewContext(createDevServiceWorkerCleanupScript(), {
      self: {
        addEventListener: (type: string, listener: ServiceWorkerListener) => listeners.set(type, listener),
        skipWaiting,
        clients: {
          claim,
          matchAll: vi.fn().mockResolvedValue([{ url: 'http://localhost:5173/app/dashboard', navigate }]),
        },
        registration: { unregister },
      },
      caches: {
        keys: vi.fn().mockResolvedValue([
          'workbox-precache-v2-http://localhost:5173/',
          'google-fonts-cache',
          'la-pluma-page-chunks',
          'unrelated-cache',
        ]),
        delete: deleteCache,
      },
    })

    let installWork: Promise<unknown> | undefined
    listeners.get('install')!({ waitUntil: (work) => { installWork = work } })
    await installWork
    expect(skipWaiting).toHaveBeenCalledOnce()

    let activateWork: Promise<unknown> | undefined
    listeners.get('activate')!({ waitUntil: (work) => { activateWork = work } })
    await activateWork

    expect(deleteCache.mock.calls.map(([cacheName]) => cacheName)).toEqual([
      'workbox-precache-v2-http://localhost:5173/',
      'google-fonts-cache',
      'la-pluma-page-chunks',
    ])
    expect(claim).toHaveBeenCalledOnce()
    expect(unregister).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith('http://localhost:5173/app/dashboard')
  })

  it('links the install manifest at the deployment path', () => {
    expect(createManifestLinkTag('/la-pluma/')).toEqual({
      tag: 'link',
      attrs: { rel: 'manifest', href: '/la-pluma/manifest.webmanifest' },
      injectTo: 'head',
    })
    expect(createManifestLinkTag('/')).toEqual({
      tag: 'link',
      attrs: { rel: 'manifest', href: '/manifest.webmanifest' },
      injectTo: 'head',
    })
  })
})
