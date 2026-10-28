/**
 * 统一日志服务
 * 提供结构化的日志记录和管理
 *
 * 适配职责：本模块是所有结构化日志的统一出口。
 * - 从日志上下文补齐 requestId/runId/operationId，使同一请求或同一执行
 *   的日志可以互相核对（控制台用 req=/run=/op= 短标签，结构化字段保持全名）；
 * - 对 message 与 data 统一脱敏，凭据类字段不进入内存日志或控制台；
 * - WARN/ERROR 写入 stderr，其余级别写入 stdout。
 */

import { getLogContext } from './logContext.ts';
import { redactLogData, redactLogText } from './logRedaction.ts';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';

/** 单条内存日志的公开字段。 */
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
    this.maxLogs = options.maxLogs || 1000; // 最多保留的日志条数
    this.enableConsole = options.enableConsole !== false; // 默认输出到控制台
  }

  /**
   * 记录日志
   */
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

    // 添加到内存日志
    this.logs.push(entry);

    // 限制日志数量
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

  /**
   * 获取日志级别对应的 emoji
   */
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

  /**
   * 便捷方法
   */
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

  /**
   * 获取最近的日志
   */
  getRecentLogs(count: number = 100): LogEntry[] {
    const startIndex = Math.max(0, this.logs.length - count);
    return this.logs.slice(startIndex);
  }

  /**
   * 获取所有日志
   */
  getAllLogs(): LogEntry[] {
    return [...this.logs];
  }

  /**
   * 清空日志
   */
  clear(): void {
    this.logs = [];
  }

  /**
   * 按级别过滤日志
   */
  filterByLevel(level: LogLevel): LogEntry[] {
    return this.logs.filter(log => log.level === level);
  }

  /**
   * 按时间范围过滤日志
   */
  filterByTimeRange(startTime: Date, endTime: Date): LogEntry[] {
    return this.logs.filter(log => {
      const logTime = new Date(log.time);
      return logTime >= startTime && logTime <= endTime;
    });
  }
}

/**
 * 全局日志管理器
 */
class LoggerManager {
  loggers: Map<string, Logger>;

  constructor() {
    this.loggers = new Map();
  }

  /**
   * 获取或创建 Logger 实例
   */
  getLogger(name: string, options?: LoggerOptions): Logger {
    if (!this.loggers.has(name)) {
      this.loggers.set(name, new Logger(name, options));
    }
    return this.loggers.get(name)!;
  }

  /**
   * 获取所有日志（合并所有 Logger）
   */
  getAllLogs(): LogEntry[] {
    const allLogs: LogEntry[] = [];
    for (const logger of this.loggers.values()) {
      allLogs.push(...logger.getAllLogs());
    }
    // 按时间排序
    return allLogs.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  }

  /**
   * 清空所有日志
   */
  clearAll(): void {
    for (const logger of this.loggers.values()) {
      logger.clear();
    }
  }
}

// 导出全局实例
export const loggerManager = new LoggerManager();

/**
 * 创建 Logger 的便捷函数
 */
export function createLogger(name: string, options?: LoggerOptions): Logger {
  return loggerManager.getLogger(name, options);
}
