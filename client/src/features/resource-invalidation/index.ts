/**
 * 资源失效微域公开面
 * 跨域发布/订阅端口与 React 订阅 hook；不持有资源数据或业务端点。
 */

export {
  RESOURCE_INVALIDATION_CAUSES,
  RESOURCE_SCOPES,
  ResourceInvalidationHub,
  getResourceInvalidationRevision,
  publishResourceInvalidation,
  resourceInvalidationHub,
  subscribeResourceInvalidation,
} from './model/resourceInvalidation'
export type {
  ResourceInvalidation,
  ResourceInvalidationCause,
  ResourceInvalidationListener,
  ResourceScope,
} from './model/resourceInvalidation'

export { useResourceInvalidation } from './hooks/useResourceInvalidation'
