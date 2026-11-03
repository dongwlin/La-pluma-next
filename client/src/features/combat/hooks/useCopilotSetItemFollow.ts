import { useEffect, useRef, type RefObject } from 'react'

// 用户手动滚动后的抑制窗口：窗口内的当前项变化跳过定位。
const USER_SCROLL_SUPPRESS_MS = 500
// 程序定位自身引发的 scroll 事件窗口：窗口内的 scroll 事件不记作用户滚动。
const OWN_SCROLL_EVENT_GUARD_MS = 200

export function useCopilotSetItemFollow({
  currentIndex,
  hasList,
}: {
  currentIndex: number | null
  hasList: boolean
}): RefObject<HTMLDivElement | null> {
  const listRef = useRef<HTMLDivElement | null>(null)
  const lastUserScrollAtRef = useRef(0)
  // 程序定位引发 scroll 事件的截止时间；该时间前的 scroll 事件不记作用户滚动。
  const ownScrollUntilRef = useRef(0)

  // 记录用户主动滚动：定位自身的 scroll 事件在守卫窗口内不算，其余都视作
  // 用户在浏览列表。容器随预览挂载，因此监听跟随列表的存在性。
  useEffect(() => {
    if (!hasList) return
    const list = listRef.current
    if (!list) return
    const handleScroll = () => {
      if (Date.now() < ownScrollUntilRef.current) return
      lastUserScrollAtRef.current = Date.now()
    }
    list.addEventListener('scroll', handleScroll, { passive: true })
    return () => list.removeEventListener('scroll', handleScroll)
  }, [hasList])

  // 当前执行项变化时把「执行中」行带入视野；用户刚滚动过则跳过一次，让
  // 手动浏览不被打断。
  useEffect(() => {
    if (currentIndex === null) return
    const list = listRef.current
    if (!list) return
    if (Date.now() - lastUserScrollAtRef.current < USER_SCROLL_SUPPRESS_MS) return
    const row = list.querySelector<HTMLElement>(`[data-copilot-item-index="${currentIndex}"]`)
    if (!row) return
    // jsdom 等测试环境没有实现 scrollIntoView；真实浏览器都有，缺失时跳过定位。
    if (typeof row.scrollIntoView !== 'function') return
    ownScrollUntilRef.current = Date.now() + OWN_SCROLL_EVENT_GUARD_MS
    row.scrollIntoView({ block: 'nearest' })
  }, [currentIndex])

  return listRef
}
