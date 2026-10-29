/**
 * 自动化页当前活动展示
 *
 * 活动信息是只读服务端资源，由 `automation/activity` Query 持有；页面与面板
 * 不再直接调用 `getActivity`。读取失败只让标签消失，不写全局状态，也不影响
 * 任务配置或执行。展示级读取不自动重试：Activity 恢复或页面重挂载时按
 * `staleTime` 重新订阅即可。
 */

import { useQuery } from '@tanstack/react-query'
import { activityQueryOptions } from '../model/queries'

export interface AutomationActivityProjection {
  code: string | null
  name: string | null
}

export function useAutomationActivity(clientType?: string): AutomationActivityProjection {
  const { data } = useQuery({
    ...activityQueryOptions(clientType),
    retry: false,
  })

  return {
    code: typeof data?.code === 'string' && data.code.length > 0 ? data.code : null,
    name: typeof data?.name === 'string' && data.name.length > 0 ? data.name : null,
  }
}
