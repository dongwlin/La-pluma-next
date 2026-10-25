/**
 * Query key 约定
 *
 * 所有服务端只读资源统一使用 `[domain, resource, ...params]`：
 * - `domain` 是资源所属域（feature 或跨域微域）的稳定标识，也是域级失效作用域；
 * - `resource` 是域内稳定资源名，不使用函数名、端点路径或页面名；
 * - `params` 只放影响响应内容的输入，按固定顺序展开；缺失参数用 `null` 或省略，
 *   不要混用 `undefined` 与省略造成两个缓存身份。
 *
 * 同一个资源的 domain/resource 段必须唯一归属一个域；迁移归属时由迁移任务
 * 明确旧 key 的兼容与失效范围，不在调用点临时改 key。
 */

/** 以域名为首段的 Query key。 */
export type DomainQueryKey<TDomain extends string = string> = readonly [TDomain, ...unknown[]]

export interface QueryKeyFactory<TDomain extends string> {
  /** 域级作用域：失效该域全部资源。 */
  readonly all: readonly [TDomain]
  /** 资源级作用域：匹配该资源的所有参数变体，也用于只失效一个资源。 */
  resource<TResource extends string>(resource: TResource): readonly [TDomain, TResource]
  /** 具体缓存身份：资源 + 影响响应的参数。 */
  query<TResource extends string, TParams extends readonly unknown[]>(
    resource: TResource,
    ...params: TParams
  ): readonly [TDomain, TResource, ...TParams]
}

/**
 * 为域创建稳定的 key 工厂。域模块只导出由它创建的对象，
 * 页面与其他域不得手写同形状的数组字面量。
 */
export function defineQueryKeys<TDomain extends string>(domain: TDomain): QueryKeyFactory<TDomain> {
  return {
    all: [domain],
    resource: <TResource extends string>(resource: TResource) => [domain, resource],
    query: <TResource extends string, TParams extends readonly unknown[]>(
      resource: TResource,
      ...params: TParams
    ) => [domain, resource, ...params],
  }
}
