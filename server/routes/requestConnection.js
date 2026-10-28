import { resolveConnectionInput } from '../services/connectionService.js';

/**
 * 请求级连接覆盖解析：查询参数与请求体按既有顺序合并，再交给连接 profile
 * 解析。执行路由与读取/维护路由共用同一适配，避免各自拼装覆盖字段。
 */
export async function resolveRequestConnection(req, { allowOverrides = false } = {}) {
  const input = { ...(req.query || {}), ...(req.body || {}) };
  return resolveConnectionInput(input, { allowOverrides });
}
