/**
 * 日志域类型
 */

export interface LogEntry {
  time: string
  level: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG'
  message: string
}

export interface LogFile {
  name: string
  path: string
  size: number
  modified: string
}
