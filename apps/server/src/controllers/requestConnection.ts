import { resolveConnectionInput } from '../services/connectionService.ts';
import type { ConnectionProfile } from '../services/connectionService.ts';
import type { ApiRequestLike } from '../utils/apiHelper.ts';

/** 连接覆盖解析只读取 query 与 body；两者保持 unknown，由连接服务统一收窄。 */
export interface RequestConnectionSource extends ApiRequestLike {
  body?: unknown;
  query?: unknown;
}

export interface RequestConnectionOptions {
  allowOverrides?: boolean;
}

/**
 * 查询参数与请求体按既有顺序合并：后者覆盖前者。
 * 非对象来源（缺失、纯量）不提供任何连接字段，与展开空对象等价；
 * 数组仍按键展开，保持旧实现的取值顺序。
 */
function spreadSource(value: unknown): object {
  return typeof value === 'object' && value !== null ? value : {};
}

/**
 * 请求级连接覆盖解析：查询参数与请求体按既有顺序合并，再交给连接 profile
 * 解析。执行路由与读取/维护路由共用同一适配，避免各自拼装覆盖字段。
 */
export async function resolveRequestConnection(
  req: RequestConnectionSource,
  { allowOverrides = false }: RequestConnectionOptions = {}
): Promise<ConnectionProfile> {
  const input = { ...spreadSource(req.query), ...spreadSource(req.body) };
  return resolveConnectionInput(input, { allowOverrides });
}
