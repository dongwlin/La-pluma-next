/**
 * 文件操作辅助工具 - 统一的文件读写逻辑
 */

import { randomUUID } from 'crypto';
import { mkdir, open, readFile, rename, unlink } from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';

const fileMutationQueues = new Map<string, Promise<unknown>>();

function enqueueFileMutation<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const queueKey = resolve(filePath);
  const previous = fileMutationQueues.get(queueKey) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  fileMutationQueues.set(queueKey, current);

  return current.finally(() => {
    if (fileMutationQueues.get(queueKey) === current) {
      fileMutationQueues.delete(queueKey);
    }
  });
}

/**
 * 未知错误的 errno 兜底读取：非对象或无字符串 code 时返回 undefined。
 */
function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

async function syncDirectory(dirPath: string): Promise<void> {
  let handle: FileHandle | null | undefined;
  try {
    handle = await open(dirPath, 'r');
    await handle.sync();
  } catch (error) {
    // Directory fsync is unavailable on some supported platforms. The file
    // itself has already been synced before rename, so only ignore that case.
    const code = getErrorCode(error);
    if (code === undefined || !['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'EBADF'].includes(code)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * 确保目录存在
 */
export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (getErrorCode(error) !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * 读取 JSON 文件。返回值显式为 unknown，由调用方自行校验收窄，本函数不冒充校验。
 */
export async function readJsonFile(filePath: string, defaultValue: unknown = null): Promise<unknown> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return defaultValue;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`读取 JSON 文件失败: ${message}`);
  }
}

async function writeJsonFileAtomic(filePath: string, data: unknown, pretty: boolean): Promise<void> {
  const targetPath = resolve(filePath);
  const targetDir = dirname(targetPath);
  // JSON.stringify 的运行时结果可能是 undefined（如顶层 undefined），因此显式按 unknown 接收再校验。
  const content: unknown = pretty
    ? JSON.stringify(data, null, 2)
    : JSON.stringify(data);

  if (typeof content !== 'string') {
    throw new TypeError('JSON 顶层值无法序列化');
  }

  await ensureDir(targetDir);

  const tempPath = join(
    targetDir,
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle: FileHandle | null | undefined;

  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = null;

    await rename(tempPath, targetPath);
    await syncDirectory(targetDir);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(tempPath).catch((cleanupError: unknown) => {
      if (getErrorCode(cleanupError) !== 'ENOENT') throw cleanupError;
    });
    throw error;
  }
}

/**
 * 写入 JSON 文件
 */
export async function writeJsonFile(filePath: string, data: unknown, pretty: boolean = true): Promise<void> {
  try {
    await enqueueFileMutation(filePath, () => writeJsonFileAtomic(filePath, data, pretty));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`写入 JSON 文件失败: ${message}`);
  }
}

/**
 * 安全地更新 JSON 文件（先读取，再合并，最后写入）。读取值显式为 unknown，由 updateFn 自行校验。
 */
export async function updateJsonFile<T>(
  filePath: string,
  updateFn: (data: unknown) => T | Promise<T>,
  defaultValue: unknown = {},
): Promise<T> {
  return enqueueFileMutation(filePath, async () => {
    const data = await readJsonFile(filePath, defaultValue);
    const updated = await updateFn(data);
    await writeJsonFileAtomic(filePath, updated, true);
    return updated;
  });
}

/**
 * 删除 JSON 文件，并与同路径的写入/更新操作串行化。
 */
export async function deleteJsonFile(filePath: string): Promise<boolean> {
  return enqueueFileMutation(filePath, async () => {
    try {
      await unlink(filePath);
      return true;
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') return false;
      throw error;
    }
  });
}
