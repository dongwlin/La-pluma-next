/**
 * 跨域资源失效端口
 *
 * 服务端资源的写入方（识别、队列、计划、资源更新）在确认成功后发布失效；
 * 读取方按显式资源作用域刷新或失效自己的缓存。端口只传递“哪些资源已变化”，
 * 不持有资源数据，也不替代 Query、配置协调器或执行控制器。
 *
 * 约束：
 * - 发布必须发生在写入确认成功之后；失败不发布。
 * - 一次发布只列出实际受影响的资源，不用域级作用域代替精确范围。
 * - 订阅者在 Activity 隐藏/卸载时注销；恢复时若期间有发布，会收到一次
 *   `activity-resume` 合成事件，避免把隐藏期间的旧数据当成新鲜结果。
 */

export const RESOURCE_SCOPES = [
  'depot',
  'operbox',
  'catalog',
  'materials',
  'training-queue',
  'training-plan',
  'automation-config',
  'automation-schedule',
  'drops',
  'open-stages',
  'dashboard-snapshot',
] as const

export type ResourceScope = (typeof RESOURCE_SCOPES)[number]

export const RESOURCE_INVALIDATION_CAUSES = [
  'recognition',
  'plan-applied',
  'training-queue',
  'training-settings',
  'resource-update',
  'activity-resume',
] as const

export type ResourceInvalidationCause = (typeof RESOURCE_INVALIDATION_CAUSES)[number]

export interface ResourceInvalidation {
  /** 实际受影响的资源；顺序无关，重复项会被合并。 */
  readonly resources: readonly ResourceScope[]
  /** 发布原因，用于订阅端区分提示与日志，不参与资源匹配。 */
  readonly cause: ResourceInvalidationCause
  /** 发布方可选携带的业务信息（如应用计划的关卡数），订阅端自行校验。 */
  readonly detail?: unknown
}

export type ResourceInvalidationListener = (invalidation: ResourceInvalidation) => void

const normalizeResources = (resources: readonly ResourceScope[]): ResourceScope[] =>
  Array.from(new Set(resources))

/**
 * 资源失效中枢。
 *
 * 每个作用域保存最后一次发布的序号；订阅者在 Activity 恢复时可用
 * `getRevision()` 判断隐藏期间是否错过发布。应用使用模块级单例，
 * 测试可以创建独立实例。
 */
export class ResourceInvalidationHub {
  private revision = 0
  private readonly revisions = new Map<ResourceScope, number>()
  private readonly listeners = new Set<ResourceInvalidationListener>()

  publish(invalidation: ResourceInvalidation): void {
    const resources = normalizeResources(invalidation.resources)
    if (resources.length === 0) return

    const revision = ++this.revision
    for (const resource of resources) this.revisions.set(resource, revision)

    const event: ResourceInvalidation = { ...invalidation, resources }
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        // 一个订阅者的异常不应阻止其他页面收到同一次失效。
        console.error('资源失效监听器执行失败', error)
      }
    }
  }

  subscribe(listener: ResourceInvalidationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 给定作用域中最近一次发布的序号；从未发布过返回 0。 */
  getRevision(resources: readonly ResourceScope[]): number {
    let revision = 0
    for (const resource of resources) {
      revision = Math.max(revision, this.revisions.get(resource) ?? 0)
    }
    return revision
  }
}

export const resourceInvalidationHub = new ResourceInvalidationHub()

export function publishResourceInvalidation(invalidation: ResourceInvalidation): void {
  resourceInvalidationHub.publish(invalidation)
}

export function subscribeResourceInvalidation(listener: ResourceInvalidationListener): () => void {
  return resourceInvalidationHub.subscribe(listener)
}

export function getResourceInvalidationRevision(resources: readonly ResourceScope[]): number {
  return resourceInvalidationHub.getRevision(resources)
}
