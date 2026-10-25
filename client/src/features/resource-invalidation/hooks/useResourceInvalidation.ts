/**
 * 跨域资源失效订阅 hook
 *
 * 订阅发生在 Effect 中，Activity 隐藏会随 Effect 清理注销，显示时重新订阅。
 * 隐藏期间若有发布，恢复时会补发一次 `activity-resume` 合成事件；
 * 页面首次挂载不补发（页面自己的首屏读取负责加载）。
 */

import { useEffect, useEffectEvent, useRef } from 'react'
import {
  resourceInvalidationHub,
  type ResourceInvalidation,
  type ResourceInvalidationHub,
  type ResourceScope,
} from '../model/resourceInvalidation'

const SCOPE_SEPARATOR = '\u0000'

const joinScopes = (resources: readonly ResourceScope[]): string => resources.join(SCOPE_SEPARATOR)

const splitScopes = (key: string): ResourceScope[] =>
  key ? (key.split(SCOPE_SEPARATOR) as ResourceScope[]) : []

/**
 * @param resources 订阅的资源作用域；调用方应传模块级常量，避免每次渲染新建身份。
 * @param handler 收到失效或恢复补发时执行；通过 Effect Event 读取最新闭包。
 * @param hub 测试可注入独立中枢，默认使用应用级单例。
 */
export function useResourceInvalidation(
  resources: readonly ResourceScope[],
  handler: (invalidation: ResourceInvalidation) => void,
  hub: ResourceInvalidationHub = resourceInvalidationHub,
): void {
  const onInvalidate = useEffectEvent(handler)
  const resourcesKey = joinScopes(resources)
  const seenRevisionRef = useRef(hub.getRevision(resources))

  useEffect(() => {
    const scopes = splitScopes(resourcesKey)
    const currentRevision = hub.getRevision(scopes)
    const lastSeenRevision = seenRevisionRef.current
    seenRevisionRef.current = currentRevision

    const unsubscribe = hub.subscribe(invalidation => {
      if (!invalidation.resources.some(resource => scopes.includes(resource))) return
      seenRevisionRef.current = hub.getRevision(scopes)
      onInvalidate(invalidation)
    })

    if (lastSeenRevision !== currentRevision) {
      onInvalidate({ resources: scopes, cause: 'activity-resume' })
    }

    return unsubscribe
  }, [hub, resourcesKey])
}
