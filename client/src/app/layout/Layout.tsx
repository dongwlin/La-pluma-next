import { AnimatePresence, motion, useReducedMotion, type PanInfo } from 'framer-motion'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Ellipsis, X } from 'lucide-react'
import { useNavigate } from 'react-router'
import ThemeToggle from './ThemeToggle'
import { appTabRoute, type AppTab } from '@/shared/navigation'
import { appTabs, type AppTabDefinition } from '../router/tabs'
import {
  DEFAULT_OPERATOR_QUOTE,
  getOperatorAvatarUrl,
  loadDailyOperatorQuote,
} from '@/features/operator-quotes'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',')
const SHEET_DISMISS_OFFSET = 96
const SHEET_DISMISS_VELOCITY = 650
const SHEET_EASE = [0.32, 0.72, 0, 1] as const

interface LayoutProps {
  activeTab: AppTab
  children: ReactNode
}

// Keep the compact mobile rail focused on the four destinations used most often.
// The remaining workspaces stay available from the adjacent more control.
const mobileTabs = appTabs.filter(tab => ['dashboard', 'automation', 'combat', 'config'].includes(tab.id))
const overflowTabs = appTabs.filter(tab => !mobileTabs.some(primary => primary.id === tab.id))

function getScrollHost() {
  return document.querySelector<HTMLElement>('.la-pluma-scroll-host')
}

function getScrollTop() {
  return getScrollHost()?.scrollTop ?? window.scrollY
}

function setScrollTop(top: number) {
  const host = getScrollHost()
  if (host) {
    host.scrollTop = top
    return
  }
  window.scrollTo({ top, left: 0, behavior: 'auto' })
}

function TabIcon({ tab, size = 'h-4 w-4' }: { tab: AppTabDefinition; size?: string }) {
  const Icon = tab.icon
  return <Icon className={size} strokeWidth={1.9} aria-hidden="true" />
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" focusable="false" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.335-1.756-1.335-1.756-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.418-1.305.762-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23a11.5 11.5 0 0 1 3.003-.404c1.02.005 2.045.138 3.003.404 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

function TabLink({
  tab,
  active,
  onNavigate,
  mobile = false,
}: {
  tab: AppTabDefinition
  active: boolean
  onNavigate: (tab: AppTab, mobile?: boolean) => void
  mobile?: boolean
}) {
  const frameworkClasses = mobile
    ? `tab-link${active ? ' tab-link-active' : ''}`
    : 'link'

  return (
    <button
      type="button"
      data-app-tab={tab.id}
      aria-current={active ? 'page' : undefined}
      onClick={() => onNavigate(tab.id, mobile)}
      className={`la-pluma-tab-link ${frameworkClasses} ${active ? 'is-active' : ''} ${mobile ? 'is-mobile-tab' : 'is-desktop-tab'}`}
    >
      {mobile ? (
        <TabIcon tab={tab} size="h-5 w-5" />
      ) : (
        <span className="la-pluma-sidebar-icon">
          <TabIcon tab={tab} size="h-4 w-4" />
        </span>
      )}
      <span className={mobile ? 'tabbar-label' : 'la-pluma-sidebar-label'}>{tab.name}</span>
    </button>
  )
}

export default function Layout({ activeTab, children }: LayoutProps) {
  const navigate = useNavigate()
  const [moreOpen, setMoreOpen] = useState(false)
  const [sidebarIdentity, setSidebarIdentity] = useState(DEFAULT_OPERATOR_QUOTE)
  const shouldReduceMotion = useReducedMotion()
  const moreTriggerRef = useRef<HTMLButtonElement>(null)
  const scrollPositions = useRef(new Map<AppTab, number>())
  // 滚动事件可能在提交后异步派发，用 ref 读取当时的 tab，避免把旧页的裁剪值记到新页。
  const activeTabRef = useRef<AppTab>(activeTab)
  const restoreFrame = useRef<number | null>(null)
  const scrollRestoreCleanupRef = useRef<(() => void) | null>(null)

  const closeMoreSheet = useCallback(() => setMoreOpen(false), [])

  useEffect(() => {
    let subscribed = true

    void loadDailyOperatorQuote().then((quote) => {
      if (subscribed) setSidebarIdentity(quote)
    }).catch(() => undefined)

    return () => {
      subscribed = false
    }
  }, [])

  useEffect(() => {
    if (!moreOpen) return undefined

    const scrollHost = getScrollHost()
    const focusReturnTarget = moreTriggerRef.current
    const previousBodyOverflow = document.body.style.overflow
    const previousScrollHostOverflow = scrollHost?.style.overflow ?? ''
    document.body.style.overflow = 'hidden'
    if (scrollHost) scrollHost.style.overflow = 'hidden'

    const focusFrame = window.requestAnimationFrame(() => {
      const sheet = document.getElementById('la-pluma-more-sheet')
      const activeLink = sheet?.querySelector<HTMLElement>('[aria-current="page"]')
      const firstFocusable = sheet?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      ;(activeLink ?? firstFocusable)?.focus({ preventScroll: true })
    })

    const handleSheetKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMoreSheet()
        return
      }
      if (event.key !== 'Tab') return

      const sheet = document.getElementById('la-pluma-more-sheet')
      if (!sheet) return
      const focusable = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
      if (focusable.length === 0) return

      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (!sheet.contains(document.activeElement)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus({ preventScroll: true })
        return
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }

    document.addEventListener('keydown', handleSheetKeyDown, true)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleSheetKeyDown, true)
      document.body.style.overflow = previousBodyOverflow
      if (scrollHost) scrollHost.style.overflow = previousScrollHostOverflow
      window.requestAnimationFrame(() => {
        if (focusReturnTarget?.isConnected) focusReturnTarget.focus({ preventScroll: true })
      })
    }
  }, [closeMoreSheet, moreOpen])

  const handleMoreSheetDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (info.offset.y >= SHEET_DISMISS_OFFSET || info.velocity.y >= SHEET_DISMISS_VELOCITY) {
      closeMoreSheet()
    }
  }

  useEffect(() => {
    const desktopQuery = window.matchMedia('(min-width: 1024px)')
    const closeOnDesktop = (event?: MediaQueryListEvent) => {
      if (event?.matches ?? desktopQuery.matches) setMoreOpen(false)
    }

    if (typeof desktopQuery.addEventListener === 'function') {
      desktopQuery.addEventListener('change', closeOnDesktop)
    } else {
      desktopQuery.addListener(closeOnDesktop)
    }
    closeOnDesktop()

    return () => {
      if (typeof desktopQuery.removeEventListener === 'function') {
        desktopQuery.removeEventListener('change', closeOnDesktop)
      } else {
        desktopQuery.removeListener(closeOnDesktop)
      }
    }
  }, [])

  const restoreScroll = useCallback((tab: AppTab) => {
    scrollRestoreCleanupRef.current?.()
    const top = scrollPositions.current.get(tab) ?? 0
    let observer: ResizeObserver | null = null
    let maxTimer: number | null = null
    let cancelled = false

    const applyScroll = () => {
      if (cancelled) return
      setScrollTop(top)
    }
    const scheduleScroll = () => {
      if (restoreFrame.current !== null) window.cancelAnimationFrame(restoreFrame.current)
      restoreFrame.current = window.requestAnimationFrame(() => {
        restoreFrame.current = null
        applyScroll()
      })
    }
    const cleanup = () => {
      if (cancelled) return
      cancelled = true
      observer?.disconnect()
      observer = null
      if (maxTimer !== null) window.clearTimeout(maxTimer)
      maxTimer = null
      if (restoreFrame.current !== null) window.cancelAnimationFrame(restoreFrame.current)
      restoreFrame.current = null
      window.removeEventListener('wheel', cleanup)
      window.removeEventListener('touchstart', cleanup)
      window.removeEventListener('pointerdown', cleanup)
      window.removeEventListener('keydown', handleUserKeyDown)
      if (scrollRestoreCleanupRef.current === cleanup) scrollRestoreCleanupRef.current = null
    }
    const handleUserKeyDown = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cleanup()
    }

    scrollRestoreCleanupRef.current = cleanup
    applyScroll()
    scheduleScroll()

    if (top <= 0) return

    const content = getScrollHost()
    if (content && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(scheduleScroll)
      observer.observe(content)
    }
    window.addEventListener('wheel', cleanup, { passive: true })
    window.addEventListener('touchstart', cleanup, { passive: true })
    window.addEventListener('pointerdown', cleanup, { passive: true })
    window.addEventListener('keydown', handleUserKeyDown)
    maxTimer = window.setTimeout(cleanup, 10_000)
  }, [])

  // 浏览器原生滚动恢复会与按 tab 的显式恢复互相干扰，统一交给 Layout 手动处理。
  useEffect(() => {
    const previousScrollRestoration = window.history.scrollRestoration
    window.history.scrollRestoration = 'manual'
    return () => {
      window.history.scrollRestoration = previousScrollRestoration
      scrollRestoreCleanupRef.current?.()
      if (restoreFrame.current !== null) window.cancelAnimationFrame(restoreFrame.current)
    }
  }, [])

  // 持续记录当前 tab 的滚动位置。异步导航（如概览快捷入口里 await 之后再跳转）
  // 期间用户仍可能继续滚动，只有跟随 scroll 事件更新才能拿到离开前的真实位置。
  useEffect(() => {
    const host = getScrollHost()
    if (!host) return undefined

    const handleScroll = () => {
      scrollPositions.current.set(activeTabRef.current, host.scrollTop)
    }
    host.addEventListener('scroll', handleScroll, { passive: true })
    return () => host.removeEventListener('scroll', handleScroll)
  }, [])

  // scroll 事件在滚动后异步派发，点击与浏览器历史仍在事件派发期间补一次精确快照：
  // - click 捕获阶段早于 React 的 click 处理器，旧页面尚未被 Activity 隐藏；
  // - popstate 处理器返回前 React 不会提交 DOM，读到的仍是旧页的 scrollTop。
  // 监听器只注册一次，通过 activeTabRef 取当时的 tab，避免提交后、effect 重订阅前
  // 命中的事件把新页位置记到旧 tab 上。
  useEffect(() => {
    const snapshotActiveScroll = () => {
      scrollPositions.current.set(activeTabRef.current, getScrollTop())
    }

    window.addEventListener('popstate', snapshotActiveScroll)
    window.addEventListener('click', snapshotActiveScroll, { capture: true, passive: true })
    return () => {
      window.removeEventListener('popstate', snapshotActiveScroll)
      window.removeEventListener('click', snapshotActiveScroll, { capture: true })
    }
  }, [])

  // activeTab 提交后恢复目标 tab 的滚动位置；只在切换（含首次挂载）时执行一次。
  useLayoutEffect(() => {
    activeTabRef.current = activeTab
    restoreScroll(activeTab)
  }, [activeTab, restoreScroll])

  const navigateToTab = (tab: AppTab, mobile = false) => {
    if (mobile) setMoreOpen(false)
    if (tab === activeTab) return
    // 先记录当前 tab 的滚动位置再切页：新页面提交后旧页会被 Activity 隐藏并裁剪 scrollTop。
    scrollPositions.current.set(activeTab, getScrollTop())
    navigate(appTabRoute(tab))
  }

  const isOverflowActive = overflowTabs.some(tab => tab.id === activeTab)

  return (
    <div className="view view-main la-pluma-view">
      <div className="page no-swipeback la-pluma-page" data-name="la-pluma">
        <div className="la-pluma-sidebar-frame" aria-hidden="true" />

        <div className="la-pluma-page-body">
          <header className="navbar la-pluma-navbar">
            <div className="navbar-bg" aria-hidden="true" />
            <div className="navbar-inner">
              <div className="left">
                <div className="la-pluma-navbar-left">
                  <button type="button" className="link la-pluma-brand" aria-label="La Pluma Next 概览" onClick={() => navigateToTab('dashboard')}>
                    <img src={`${import.meta.env.BASE_URL}logo-graphite.svg?v=1`} alt="" className="la-pluma-brand-mark" />
                    <span>La Pluma Next</span>
                  </button>
                </div>
              </div>
              <div className="title">
                <div className="la-pluma-navbar-title">{appTabs.find(tab => tab.id === activeTab)?.name}</div>
              </div>
              <div className="right">
                <div className="la-pluma-navbar-actions">
                  <ThemeToggle />
                  <a
                    href="https://github.com/dongwlin/La-pluma-next"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="link la-pluma-github-link"
                    aria-label="打开 GitHub 仓库"
                  >
                    <GitHubMark />
                  </a>
                </div>
              </div>
            </div>
          </header>

          <aside className="la-pluma-sidebar" aria-label="主要功能">
            <nav className="la-pluma-sidebar-nav" aria-label="工作台">
              {appTabs.map(tab => (
                <TabLink key={tab.id} tab={tab} active={activeTab === tab.id} onNavigate={navigateToTab} />
              ))}
            </nav>

            <div
              className="la-pluma-sidebar-identity"
              aria-label={`${sidebarIdentity.operator}：${sidebarIdentity.quote}`}
            >
              <span className="la-pluma-sidebar-avatar" aria-hidden="true">
                <img
                  key={sidebarIdentity.operatorId}
                  src={getOperatorAvatarUrl(sidebarIdentity.operatorId)}
                  alt=""
                  decoding="async"
                  onError={(event) => {
                    const target = event.currentTarget
                    if (target.dataset.fallbackApplied === 'true') return
                    target.dataset.fallbackApplied = 'true'
                    target.src = `${import.meta.env.BASE_URL}logo-graphite.svg?v=1`
                  }}
                />
              </span>
              <span className="la-pluma-sidebar-identity-copy">
                <strong title={sidebarIdentity.operator}>{sidebarIdentity.operator}</strong>
                <small title={sidebarIdentity.quote}>{sidebarIdentity.quote}</small>
              </span>
            </div>
          </aside>

          <main className="la-pluma-scroll-host">
            <div className="la-pluma-content app-shell">
              {children}
            </div>
          </main>
        </div>

        <footer className="toolbar toolbar-bottom tabbar tabbar-icons la-pluma-tabbar">
          <div className="toolbar-inner">
            <nav className="la-pluma-tabbar-pill app-liquid-tab-pill" aria-label="主要功能">
              {mobileTabs.map(tab => (
                <TabLink key={tab.id} tab={tab} active={activeTab === tab.id} onNavigate={navigateToTab} mobile />
              ))}
            </nav>
            <button
              type="button"
              ref={moreTriggerRef}
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              aria-controls="la-pluma-more-sheet"
              onClick={() => setMoreOpen(true)}
              className={`tab-link la-pluma-tabbar-search ${isOverflowActive || moreOpen ? 'is-active tab-link-active' : ''}`}
              aria-label="更多页面"
            >
              <Ellipsis className="la-pluma-tabbar-search-icon" strokeWidth={2.1} aria-hidden="true" />
            </button>
          </div>
        </footer>

        <AnimatePresence>
          {moreOpen && (
            <>
              <motion.div
                key="more-sheet-backdrop"
                className="sheet-backdrop backdrop-in"
                aria-hidden="true"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: shouldReduceMotion ? 0.12 : 0.16, ease: SHEET_EASE }}
                style={{ transition: 'none' }}
                onClick={closeMoreSheet}
              />
              <motion.section
                key="more-sheet"
                id="la-pluma-more-sheet"
                className="sheet-modal sheet-modal-bottom modal-in la-pluma-more-sheet"
                role="dialog"
                aria-modal="true"
                aria-labelledby="la-pluma-more-sheet-title"
                tabIndex={-1}
                initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: '100%' }}
                animate={{ opacity: 1, y: 0 }}
                exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: '100%' }}
                transition={shouldReduceMotion
                  ? { duration: 0.12, ease: SHEET_EASE }
                  : {
                      y: { duration: 0.28, ease: SHEET_EASE },
                      opacity: { duration: 0.16, ease: SHEET_EASE },
                    }}
                drag={shouldReduceMotion ? false : 'y'}
                dragConstraints={{ top: 0, bottom: 0 }}
                dragElastic={{ top: 0.06, bottom: 0.72 }}
                dragMomentum={false}
                dragDirectionLock
                onDragEnd={handleMoreSheetDragEnd}
                style={{
                  touchAction: shouldReduceMotion ? undefined : 'pan-x',
                  transition: 'none',
                }}
              >
                <div className="sheet-modal-inner">
                  <div className="la-pluma-sheet-grabber" aria-hidden="true" />
                  <div className="la-pluma-sheet-heading">
                    <div>
                      <span className="la-pluma-eyebrow">LA PLUMA NEXT</span>
                      <h2 id="la-pluma-more-sheet-title">更多工作区</h2>
                    </div>
                    <button
                      type="button"
                      className="link icon-only sheet-close la-pluma-sheet-close"
                      aria-label="关闭更多工作区"
                      onClick={closeMoreSheet}
                    >
                      <X className="h-5 w-5" aria-hidden="true" />
                    </button>
                  </div>
                  <nav aria-label="更多功能" className="la-pluma-sheet-nav">
                    {overflowTabs.map(tab => (
                      <TabLink key={tab.id} tab={tab} active={activeTab === tab.id} onNavigate={navigateToTab} mobile />
                    ))}
                  </nav>
                </div>
              </motion.section>
            </>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
