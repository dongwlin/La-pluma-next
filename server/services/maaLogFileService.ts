import { readdir, stat, unlink, realpath, open } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createLogger } from '../utils/logger.ts';
import { resolveBoundedInteger } from '../utils/numericQueryHelper.ts';
import { resolveMaaPaths } from '../config/paths.ts';
import { execMaaCommandUnlocked } from './maaProcessService.ts';

/**
 * MAA 日志文件 IO 与检查点。
 *
 * - 目录由 `maa dir log` 解析（非设备变更命令，不申请执行租约），并在
 *   进程内缓存解析结果；失败在短冷却期内复用同一个错误。
 * - 读取只允许日志目录内、扩展名为 `.log` 的文件：先 realpath 再按目录边界
 *   判定，目录外符号链接与悬空目标都会被拒绝；内容从文件尾部按块读取并限制
 *   最大字节数，行数上限与清理阈值保持既有对外契约。
 * - 检查点与增量读取接受日志目录、stat 与 open 端口注入，测试可以不依赖
 *   真实 MAA CLI 或真实日志目录验证“只读新增字节”的语义。
 * - 实时日志缓冲不在这里：它属于 maaProcessService 的子进程投影。
 */

const logger = createLogger('MaaService');

// 读取日志文件时的行数上限；/logs/files 的 lines 参数按它夹取。
export const MAX_LOG_FILE_LINES = 5000;

/** 单次读取日志内容的最大字节数；尾部读取不会把整份大日志载入内存。 */
export const MAX_LOG_FILE_READ_BYTES = 2 * 1024 * 1024;

const LOG_READ_CHUNK_BYTES = 64 * 1024;

/** 日志目录内的单个日志文件条目。 */
export interface MaaLogFileEntry {
  name: string;
  path: string;
  size: number;
  modified: string;
}

/** 执行后增量读取的起点；size 是创建检查点时的文件字节数。 */
export interface MaaLogCheckpoint {
  logPath: string;
  size: number;
}

/** stat 端口只读取文件大小。 */
export interface MaaLogFileStats {
  size: number;
}

/** open 端口返回的读取句柄；调用方负责 close。 */
export interface MaaLogFileHandle {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number; buffer: Buffer }>;
  close(): Promise<void>;
}

export interface MaaLogCheckpointPorts {
  resolveLogDir?(): Promise<string>;
  stat?(path: string): Promise<MaaLogFileStats>;
}

export interface MaaLogReadPorts {
  stat?(path: string): Promise<MaaLogFileStats>;
  open?(path: string, flags: 'r'): Promise<MaaLogFileHandle>;
}

/** readLogFile 的输出；只返回文件末尾的行。 */
export interface MaaLogFileContent {
  content: string;
  totalLines: number;
  returnedLines: number;
}

/** cleanupLogs 的删除统计。 */
export interface MaaLogCleanupResult {
  deletedCount: number;
  freedSpace: number;
}

/** MAA 调试截图条目。 */
export interface MaaDebugScreenshot {
  name: string;
  path: string;
  size: number;
  modified: string;
}

/** 目录边界判定所需的 path 能力；可注入 path.win32/path.posix 验证跨平台策略。 */
export interface MaaPathPolicy {
  relative(from: string, to: string): string;
  readonly sep: string;
  isAbsolute(path: string): boolean;
}

/**
 * 获取 MAA 日志目录
 *
 * 目录由进程环境决定，一次进程生命周期内不变；`/logs/files`、检查点与
 * 增量读取共享同一次 CLI 查询。失败在短冷却期内复用同一个错误。
 */
let logDirPromise: Promise<string> | null = null;
let logDirFailure: { error: unknown; at: number } | null = null;

/** 日志目录查询失败后的冷却时间，避免 CLI 故障时每次读取都重新 spawn。 */
const LOG_DIR_FAILURE_TTL_MS = 30_000;

async function getMaaLogDir(): Promise<string> {
  const now = Date.now();
  if (logDirFailure) {
    if (now - logDirFailure.at < LOG_DIR_FAILURE_TTL_MS) throw logDirFailure.error;
    logDirFailure = null;
  }
  if (!logDirPromise) {
    logDirPromise = execMaaCommandUnlocked('dir', ['log'], null, null, false, true)
      .then(result => result.stdout.trim())
      .catch(error => {
        const wrapped = new Error(`获取日志目录失败: ${error instanceof Error ? error.message : String(error)}`);
        logDirFailure = { error: wrapped, at: Date.now() };
        logDirPromise = null;
        throw wrapped;
      });
  }
  return logDirPromise;
}

async function collectMaaLogFiles(logDir: string): Promise<MaaLogFileEntry[]> {
  const files: MaaLogFileEntry[] = [];

  async function scanDir(dir: string, prefix = ''): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await scanDir(fullPath, prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.name.endsWith('.log')) {
        const stats = await stat(fullPath);
        files.push({
          name: prefix ? `${prefix}/${entry.name}` : entry.name,
          path: fullPath,
          size: stats.size,
          modified: stats.mtime.toISOString()
        });
      }
    }
  }

  await scanDir(logDir);
  return files;
}

/**
 * 记录 asst.log 当前大小，供执行后只读取新增内容。
 * ports.resolveLogDir / ports.stat 可覆盖目录解析与文件状态读取。
 */
export async function createMaaLogCheckpoint(
  ports: MaaLogCheckpointPorts = {}
): Promise<MaaLogCheckpoint | null> {
  const resolveLogDir = ports.resolveLogDir || getMaaLogDir;
  const statFile = ports.stat || stat;
  try {
    const logPath = join(await resolveLogDir(), 'asst.log');
    const logStats = await statFile(logPath);
    return { logPath, size: logStats.size };
  } catch (error) {
    logger.debug('无法创建 Maa 日志检查点', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * 读取检查点之后新增的日志字节（最多 maxBytes）。
 * ports.stat / ports.open 可覆盖文件状态与打开操作。
 */
export async function readMaaLogSince(
  checkpoint: MaaLogCheckpoint | null,
  maxBytes = 2 * 1024 * 1024,
  ports: MaaLogReadPorts = {}
): Promise<string> {
  if (!checkpoint?.logPath) return '';

  const statFile = ports.stat || stat;
  const openFile = ports.open || open;
  try {
    const logStats = await statFile(checkpoint.logPath);
    if (logStats.size <= checkpoint.size) return '';

    const availableBytes = logStats.size - checkpoint.size;
    const bytesToRead = Math.min(availableBytes, maxBytes);
    const start = logStats.size - bytesToRead;
    const buffer = Buffer.alloc(bytesToRead);
    const handle = await openFile(checkpoint.logPath, 'r');
    try {
      await handle.read(buffer, 0, bytesToRead, start);
    } finally {
      await handle.close();
    }
    return buffer.toString('utf-8');
  } catch (error) {
    logger.debug('无法读取 Maa 增量日志', { error: error instanceof Error ? error.message : String(error) });
    return '';
  }
}

/**
 * 获取日志文件列表
 */
export async function getLogFiles(): Promise<MaaLogFileEntry[]> {
  try {
    const logDir = await getMaaLogDir();
    const files = await collectMaaLogFiles(logDir);
    // 按修改时间倒序排序
    files.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

    return files;
  } catch (error) {
    logger.error('获取日志文件列表失败', { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/**
 * 手动清理日志文件
 */
export async function cleanupLogs(maxSizeMB: unknown = 10): Promise<MaaLogCleanupResult> {
  try {
    const sizeLimit = Number(maxSizeMB);
    if (!Number.isFinite(sizeLimit) || sizeLimit < 1 || sizeLimit > 1024) {
      throw new Error('日志保留上限必须在 1 到 1024 MB 之间');
    }

    const logDir = await getMaaLogDir();
    const files = await collectMaaLogFiles(logDir);
    files.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

    const maxSize = sizeLimit * 1024 * 1024;
    let totalSize = 0;
    const filesToDelete: MaaLogFileEntry[] = [];

    for (const file of files) {
      totalSize += file.size;
      if (totalSize > maxSize) {
        filesToDelete.push(file);
      }
    }

    for (const file of filesToDelete) {
      await unlink(file.path);
    }

    return {
      deletedCount: filesToDelete.length,
      freedSpace: filesToDelete.reduce((sum, f) => sum + f.size, 0)
    };
  } catch (error) {
    throw new Error(`清理日志失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 判断目标路径是否落在目录之外；等于目录本身同样视为越界。
 * pathImpl 可注入 path.win32 等实现，使 Windows 路径策略可以脱离运行平台验证。
 */
export function isPathOutsideDir(
  logDir: string,
  requestedPath: string,
  pathImpl: MaaPathPolicy = { relative, sep, isAbsolute }
): boolean {
  const relativePath = pathImpl.relative(logDir, requestedPath);
  return !relativePath
    || relativePath === '..'
    || relativePath.startsWith(`..${pathImpl.sep}`)
    || pathImpl.isAbsolute(relativePath);
}

/**
 * 从文件尾部读取最多 MAX_LOG_FILE_READ_BYTES 字节，并标明是否从文件开头开始。
 * 分块读取避免一次性分配整个文件大小的缓冲区。
 */
async function readLogTail(
  handle: MaaLogFileHandle,
  fileSize: number
): Promise<{ text: string; startsAtBeginning: boolean; startsAtLineBoundary: boolean }> {
  const bytesToRead = Math.min(fileSize, MAX_LOG_FILE_READ_BYTES);
  const start = fileSize - bytesToRead;
  const buffer = Buffer.alloc(bytesToRead);
  let offset = 0;
  while (offset < bytesToRead) {
    const chunkSize = Math.min(LOG_READ_CHUNK_BYTES, bytesToRead - offset);
    const { bytesRead } = await handle.read(buffer, offset, chunkSize, start + offset);
    if (bytesRead <= 0) break;
    offset += bytesRead;
  }

  let startsAtLineBoundary = start === 0;
  if (start > 0) {
    // 窗口可能从某行中间开始；先看窗口前一个字节，决定是否丢弃首行残片。
    const boundary = Buffer.alloc(1);
    const { bytesRead } = await handle.read(boundary, 0, 1, start - 1);
    startsAtLineBoundary = bytesRead === 1 && boundary[0] === 0x0a;
  }

  return {
    text: buffer.subarray(0, offset).toString('utf-8'),
    startsAtBeginning: start === 0,
    startsAtLineBoundary
  };
}

/** 分块统计换行符，保留 `totalLines` 的既有语义且不把整份文件留在内存。 */
async function countLogLines(handle: MaaLogFileHandle, fileSize: number): Promise<number> {
  const buffer = Buffer.alloc(LOG_READ_CHUNK_BYTES);
  let position = 0;
  let newlines = 0;
  while (position < fileSize) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, fileSize - position), position);
    if (bytesRead <= 0) break;
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] === 0x0a) newlines += 1;
    }
    position += bytesRead;
  }
  // split('\n') 语义：换行数 + 1，空文件也有一行空内容。
  return newlines + 1;
}

/**
 * 读取日志文件内容
 *
 * 只从文件尾部按块读取，单次最多 MAX_LOG_FILE_READ_BYTES 字节；返回最后
 * `lines` 行，并保留结尾换行对应的空行（与 split('\n') 的既有语义一致）。
 */
export async function readLogFile(filePath: string, lines: unknown = 1000): Promise<MaaLogFileContent> {
  // 直接调用也受限：非法输入回落默认值，有限值截断并夹取到公开行数上限。
  const lineCount = resolveBoundedInteger(lines, {
    defaultValue: 1000,
    min: 1,
    max: MAX_LOG_FILE_LINES
  });
  try {
    const logDir = await realpath(resolve(await getMaaLogDir()));
    const requestedPath = await realpath(resolve(filePath));

    if (isPathOutsideDir(logDir, requestedPath) || extname(requestedPath).toLowerCase() !== '.log') {
      throw new Error('只能读取 MAA 日志目录内的文件');
    }

    const fileStats = await stat(requestedPath);
    const handle = await open(requestedPath, 'r');
    try {
      const tail = await readLogTail(handle, fileStats.size);
      const allLines = tail.text.split('\n');
      if (!tail.startsAtBeginning && !tail.startsAtLineBoundary) {
        // 首元素是从窗口起点截断的行残片，不属于“最后 N 行”。
        allLines.shift();
      }

      const totalLines = tail.startsAtBeginning
        ? tail.text.split('\n').length
        : await countLogLines(handle, fileStats.size);

      // 只返回最后 N 行
      const startIndex = Math.max(0, allLines.length - lineCount);
      const selectedLines = allLines.slice(startIndex);

      return {
        content: selectedLines.join('\n'),
        totalLines,
        returnedLines: selectedLines.length
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw new Error(`读取日志文件失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 获取 MAA 调试截图列表
 */
export async function getDebugScreenshots(): Promise<MaaDebugScreenshot[]> {
  try {
    // MAA 的状态目录（Linux 为 XDG_STATE_HOME/maa）下才是调试产物目录；
    // 不能用配置目录的相邻目录推算，否则会落到 ~/.config/debug。
    const debugDir = join(resolveMaaPaths().stateDir, 'debug');

    logger.debug('调试目录', { debugDir });

    // 读取 debug 目录下的所有文件
    const files = await readdir(debugDir);

    // 筛选图片文件
    const imageFiles = files.filter(file =>
      file.endsWith('.png') || file.endsWith('.jpg') || file.endsWith('.jpeg')
    );

    // 获取文件信息；响应只暴露文件名，不返回服务器绝对路径。
    const screenshots = await Promise.all(
      imageFiles.map(async (file) => {
        const filePath = join(debugDir, file);
        const stats = await stat(filePath);
        return {
          name: file,
          path: file,
          size: stats.size,
          modified: stats.mtime.toISOString()
        };
      })
    );

    // 按修改时间倒序排序
    screenshots.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

    return screenshots;
  } catch (error) {
    logger.error('获取调试截图失败', { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}
