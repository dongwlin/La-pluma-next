/**
 * 所有服务端只读资源统一使用 `[domain, resource, ...params]`：`resource` 不使用函数名、端点路径或页面名，
 * `params` 只放影响响应的输入、按固定顺序展开；缺失参数用 `null` 或省略，混用 `undefined` 与省略会造出两个缓存身份。
 */

export type DomainQueryKey<TDomain extends string = string> = readonly [TDomain, ...unknown[]]

export interface QueryKeyFactory<TDomain extends string> {
  readonly all: readonly [TDomain]
  resource<TResource extends string>(resource: TResource): readonly [TDomain, TResource]
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
