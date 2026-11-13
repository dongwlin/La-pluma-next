export interface LogEntry {
  readonly time: string
  readonly level: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG'
  readonly message: string
  /** 服务端采集身份；兼容没有事件身份的旧服务端与历史文件。 */
  readonly id?: string
  readonly sequence?: number
  readonly source?: 'realtime' | 'history'
  /** 完整采集时间或历史行时间，不受时间显示格式影响。 */
  readonly timestamp?: string
  /** 服务端脱敏后的原消息，或历史文件的完整一行。 */
  readonly sourceText?: string
  /** 原始采集信封；解析内层 MaaCore 前缀不能覆盖这些字段。 */
  readonly envelope?: Readonly<Record<string, unknown>>
  /** 服务端执行上下文带来的 run 归属；只有实时条目携带，历史文件没有。 */
  readonly runId?: string
  readonly operationId?: string
}

export interface LogFile {
  name: string
  path: string
  size: number
  modified: string
}
