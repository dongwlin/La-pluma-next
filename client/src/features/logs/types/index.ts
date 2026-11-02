/**
 * 日志域类型
 */

export interface LogEntry {
  time: string
  level: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG'
  message: string
  /** 服务端执行上下文带来的 run 归属；只有实时条目携带，历史文件没有。 */
  runId?: string
  operationId?: string
  /** 详细模式下可展开的原始消息；仅当原始内容与展示消息不同时存在。 */
  raw?: string
}

export interface LogFile {
  name: string
  path: string
  size: number
  modified: string
}
