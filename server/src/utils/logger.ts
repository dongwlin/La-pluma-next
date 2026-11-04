import { getLogContext } from './logContext.ts';
import { redactLogData, redactLogText } from './logRedaction.ts';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';

export interface LogEntry {
  time: string;
  level: LogLevel;
  message: string;
  service: string;
  data?: unknown;
  /** 关联字段只在上下文中存在时写入，不写入 null 占位。 */
  requestId?: string;
  runId?: string;
  operationId?: string;
}

export interface LoggerOptions {
  maxLogs?: number;
  enableConsole?: boolean;
}

class Logger {
  name: string;
  logs: LogEntry[];
  maxLogs: number;
  enableConsole: boolean;

  constructor(name: string, options: LoggerOptions = {}) {
    this.name = name;
    this.logs = [];
    this.maxLogs = options.maxLogs || 1000;
    this.enableConsole = options.enableConsole !== false;
  }

  log(level: LogLevel, message: string, data: unknown = null): LogEntry {
    const context = getLogContext();
    const entry: LogEntry = {
      time: new Date().toISOString(),
      level,
      message: redactLogText(message),
      service: this.name
    };
    if (context.requestId) entry.requestId = context.requestId;
    if (context.runId) entry.runId = context.runId;
    if (context.operationId) entry.operationId = context.operationId;
    // 与原 `...(data && { data })` 等价：data 为假值（含 null）时不携带 data 字段
    if (data) {
      entry.data = redactLogData(data);
    }

    this.logs.push(entry);

    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // 输出到控制台：错误与警告走 stderr，其余走 stdout。
    // DEBUG 行是高频诊断输出，控制台省略关联标签以保持可读性；结构化 entry
    // 始终携带 requestId/runId/operationId，轮询与日志查询读取的是完整字段。
    if (this.enableConsole) {
      const emoji = this.getLevelEmoji(level);
      const contextLabel = level === 'DEBUG'
        ? ''
        : [
            context.requestId ? `req=${context.requestId}` : '',
            context.runId ? `run=${context.runId}` : '',
            context.operationId ? `op=${context.operationId}` : ''
          ].filter(Boolean).join(' ');
      const line = `${emoji} [${this.name}][${level}]${contextLabel ? `[${contextLabel}]` : ''} ${entry.message}`;
      const sink = level === 'ERROR' || level === 'WARN' ? console.error : console.log;
      if (entry.data === undefined) {
        sink(line);
      } else {
        sink(line, entry.data);
      }
    }

    return entry;
  }

  getLevelEmoji(level: LogLevel): string {
    const emojis: Record<LogLevel, string> = {
      DEBUG: '🔍',
      INFO: 'ℹ️',
      WARN: '⚠️',
      ERROR: '❌',
      SUCCESS: '✅'
    };
    return emojis[level] || 'ℹ️';
  }

  debug(message: string, data?: unknown): LogEntry {
    return this.log('DEBUG', message, data);
  }

  info(message: string, data?: unknown): LogEntry {
    return this.log('INFO', message, data);
  }

  warn(message: string, data?: unknown): LogEntry {
    return this.log('WARN', message, data);
  }

  error(message: string, data?: unknown): LogEntry {
    return this.log('ERROR', message, data);
  }

  success(message: string, data?: unknown): LogEntry {
    return this.log('SUCCESS', message, data);
  }

  getRecentLogs(count: number = 100): LogEntry[] {
    const startIndex = Math.max(0, this.logs.length - count);
    return this.logs.slice(startIndex);
  }

  getAllLogs(): LogEntry[] {
    return [...this.logs];
  }

  clear(): void {
    this.logs = [];
  }

  filterByLevel(level: LogLevel): LogEntry[] {
    return this.logs.filter(log => log.level === level);
  }

  filterByTimeRange(startTime: Date, endTime: Date): LogEntry[] {
    return this.logs.filter(log => {
      const logTime = new Date(log.time);
      return logTime >= startTime && logTime <= endTime;
    });
  }
}

class LoggerManager {
  loggers: Map<string, Logger>;

  constructor() {
    this.loggers = new Map();
  }

  getLogger(name: string, options?: LoggerOptions): Logger {
    if (!this.loggers.has(name)) {
      this.loggers.set(name, new Logger(name, options));
    }
    return this.loggers.get(name)!;
  }

  getAllLogs(): LogEntry[] {
    const allLogs: LogEntry[] = [];
    for (const logger of this.loggers.values()) {
      allLogs.push(...logger.getAllLogs());
    }
    return allLogs.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  }

  clearAll(): void {
    for (const logger of this.loggers.values()) {
      logger.clear();
    }
  }
}

export const loggerManager = new LoggerManager();

export function createLogger(name: string, options?: LoggerOptions): Logger {
  return loggerManager.getLogger(name, options);
}
