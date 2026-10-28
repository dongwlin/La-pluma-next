/**
 * 文件操作辅助工具 - 统一的文件读写逻辑
 */

import { randomUUID } from 'crypto';
import { access, constants, mkdir, open, readFile, rename, stat, unlink } from 'fs/promises';
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

/**
 * 读取文本文件；文件不存在返回 null，其余 IO 失败原样抛出，由调用方决定是否降级。
 */
async function readTextFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * 读取既有目标文件的权限位。原子替换会换成新的 inode，必须显式沿用旧权限；
 * 目标不存在（ENOENT）时返回 null，由调用方使用新建文件的默认模式。
 */
async function resolveTargetMode(filePath: string): Promise<number | null> {
  try {
    const targetStat = await stat(filePath);
    return targetStat.mode & 0o777;
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeTextFileAtomic(filePath: string, content: string): Promise<void> {
  const targetPath = resolve(filePath);
  const targetDir = dirname(targetPath);
  await ensureDir(targetDir);

  const targetMode = await resolveTargetMode(targetPath);
  if (targetMode !== null) {
    // 原子替换以目录写权限为准，会绕过目标文件自身的只读位；显式检查可写性，
    // 保持直接写入时只读文件无法覆盖的行为。
    await access(targetPath, constants.W_OK);
  }
  const tempPath = join(
    targetDir,
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle: FileHandle | null | undefined;

  try {
    handle = await open(tempPath, 'wx', targetMode ?? 0o666);
    if (targetMode !== null) {
      // open 的 mode 会经过 umask；显式 chmod 才能完整保留既有文件的权限位。
      await handle.chmod(targetMode);
    }
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
 * 写入文本文件（临时文件 + 原子替换）。不解析内容，TOML/纯文本等非 JSON 载荷可直接使用；
 * 替换后保留既有目标文件的权限位。
 */
export async function writeTextFile(filePath: string, content: string): Promise<void> {
  try {
    await enqueueFileMutation(filePath, () => writeTextFileAtomic(filePath, content));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`写入文本文件失败: ${message}`);
  }
}

/**
 * 安全地更新文本文件：读取、交给 updateFn 生成新内容、原子写回，三步在同一路径排队单元内完成，
 * 同一文件的并发读改写不会互相覆盖。文件缺失时 current 为 null；updateFn 抛错或读取失败时不写回，
 * 已有内容保持不变。
 */
export async function updateTextFile(
  filePath: string,
  updateFn: (current: string | null) => string | Promise<string>,
): Promise<string> {
  return enqueueFileMutation(filePath, async () => {
    const current = await readTextFileIfExists(filePath);
    const updated = await updateFn(current);
    await writeTextFileAtomic(filePath, updated);
    return updated;
  });
}
