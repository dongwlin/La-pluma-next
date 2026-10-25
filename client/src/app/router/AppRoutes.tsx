import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { appTabRoute, type AppTab } from '@/shared/navigation'
import { VisitedWorkspaces } from './VisitedWorkspaces'

interface AppRoutesProps {
  activeTab: AppTab
}

/**
 * URL 规范化 + 工作区保活出口。
 *
 * 这里刻意不使用 <Routes>/useRoutes：React Router 在导航时会卸载上一个路由元素，
 * 而本应用要求访问过的页面持续挂载（仅由 Activity 切换可见性）。因此路由表
 * （appRoutes）只作为静态数据，页面渲染始终由 VisitedWorkspaces 负责。
 */
export function AppRoutes({ activeTab }: AppRoutesProps) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const canonicalPath = appTabRoute(activeTab)

  // 同步 URL：/、/app、/app/ 与未知 tab 归一到默认页，非规范路径
  // （如 /app/logs/details）归一到 /app/logs。路径已规范时不发起导航，
  // 查询串与 hash 因此原样保留。
  //
  // 这里必须用 useEffect 而不是 useLayoutEffect：BrowserRouter 在自身
  // useLayoutEffect 里才订阅 history，而父组件的 layout effect 晚于子组件执行。
  // 首次挂载时在 layout effect 中导航只会改写 URL，路由状态收不到通知。
  // react-router 内置的 <Navigate> 同样使用 useEffect。
  useEffect(() => {
    if (pathname.replace(/\/+$/, '') !== canonicalPath) {
      navigate(canonicalPath, { replace: true })
    }
  }, [canonicalPath, navigate, pathname])

  return <VisitedWorkspaces activeTab={activeTab} />
}
