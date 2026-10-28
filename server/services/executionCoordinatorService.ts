/**
 * 设备变更租约
 *
 * 协作进程通过锁文件表达“谁在变更设备”。租约只做互斥，不记录业务结果：
 * - `held`：锁记录的 PID 仍存活；
 * - `stale`：锁文件仍存在但记录的进程已不存活，可以回收；
 * - `unknown`：锁文件存在但无法解析，必须按未知处理，不能当作空闲。
 *
 * 同一异步流内的重入只增加深度，不重复写锁；关闭开始时拒绝新的设备变更权。
 */

import { AsyncLocalStorage } from 'async_hooks';
import { mkdir, open, readFile, unlink } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { assertExecutionAdmissionOpen } from './executionAdmissionService.ts';

const serviceDir = dirname(fileURLToPath(import.meta.url));
const defaultLockPath = join(serviceDir, '../data/maa-execution.lock');

/** 申请租约时可提供的描述字段；缺省值由本模块补齐。 */
export interface MaaExecutionLeaseRequest {
  source?: string | null;
  taskName?: string | null;
  command?: string | null;
}

/** 锁文件记录的主体；无法核实的字段为 null，调用方不能把 null 当成已知值。 */
export interface MaaExecutionOwner {
  pid: number | null;
  source: string | null;
  taskName: string | null;
  command: string | null;
  startedAt: string | null;
}

/** 本进程实际写入的锁元数据：pid 与 source 一定存在。 */
export interface MaaExecutionLeaseMetadata {
  pid: number;
  source: string;
  taskName: string | null;
  command: string | null;
  startedAt: string;
}

export type MaaExecutionLeaseState = 'free' | 'held' | 'stale' | 'unknown';

/** 只读租约投影；`unknown` 必须区别于 `free`。 */
export type MaaExecutionLeaseSnapshot =
  | { state: 'free'; owner: null }
  | { state: 'held' | 'stale'; owner: MaaExecutionOwner }
  | { state: 'unknown'; owner: null; reason: string };

export interface MaaExecutionLease {
  owner: MaaExecutionOwner;
  lockPath: string;
  /** true 表示同一异步流内的重入租约，release 只减少深度。 */
  reentrant: boolean;
  release(): Promise<void>;
}

interface ExecutionContextStore {
  lease: MaaExecutionLease;
  depth: number;
}

const executionContext = new AsyncLocalStorage<ExecutionContextStore>();

export class MaaExecutionBusyError extends Error {
  code: string;
  statusCode: number;
  retryable: boolean;
  owner: MaaExecutionOwner | null;
  details: { owner: MaaExecutionOwner | null };

  constructor(owner: MaaExecutionOwner | null = null) {
    super(owner?.taskName ? `MAA 正在执行：${owner.taskName}` : 'MAA 正在被其他任务使用');
    this.name = 'MaaExecutionBusyError';
    this.code = 'MAA_EXECUTION_BUSY';
    this.statusCode = 409;
    this.retryable = true;
    this.owner = owner;
    this.details = { owner };
  }
}

function getLockPath(): string {
  return process.env.LA_PLUMA_MAA_LOCK_FILE || defaultLockPath;
}

function isProcessAlive(pid: number | null): boolean {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCodeOf(error) === 'EPERM';
  }
}

function errorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取并解析锁文件；文件缺失、IO 失败或 JSON 无法解析都返回 null，由调用方区分快照状态。 */
async function readOwner(lockPath: string = getLockPath()): Promise<unknown> {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

/** 锁元数据来自磁盘，逐字段从 unknown 收窄；整体不是对象时按无法解释处理。 */
function normalizeLeaseOwner(owner: unknown): MaaExecutionOwner | null {
  if (!isRecord(owner)) return null;
  const pid = Number(owner.pid);
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    source: stringField(owner.source),
    taskName: stringField(owner.taskName),
    command: stringField(owner.command),
    startedAt: stringField(owner.startedAt)
  };
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Reports the lease without mutating it. `held` means the recorded owner
 * process is alive; `stale` means the lock file exists but is reclaimable;
 * `unknown` means the file exists but cannot be interpreted.
 */
export async function getMaaExecutionLeaseSnapshot(): Promise<MaaExecutionLeaseSnapshot> {
  let raw: string;
  try {
    raw = await readFile(getLockPath(), 'utf8');
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') return { state: 'free', owner: null };
    return { state: 'unknown', owner: null, reason: errorCodeOf(error) || 'read_failed' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'unknown', owner: null, reason: 'invalid_json' };
  }

  const owner = normalizeLeaseOwner(parsed);
  if (!owner) return { state: 'unknown', owner: null, reason: 'invalid_owner' };
  return {
    state: isProcessAlive(owner.pid) ? 'held' : 'stale',
    owner
  };
}

async function removeStaleLock(lockPath: string): Promise<MaaExecutionOwner | null> {
  const owner = normalizeLeaseOwner(await readOwner(lockPath));
  if (owner && isProcessAlive(owner.pid)) return owner;
  await unlink(lockPath).catch(error => {
    if (errorCodeOf(error) !== 'ENOENT') throw error;
  });
  return null;
}

export async function acquireMaaExecutionLease(
  owner: MaaExecutionLeaseRequest = {}
): Promise<MaaExecutionLease> {
  const active = executionContext.getStore();
  if (active?.lease) {
    active.depth += 1;
    return {
      ...active.lease,
      reentrant: true,
      release: async () => {
        active.depth = Math.max(1, active.depth - 1);
      }
    };
  }

  // 关闭开始后不再授予新的设备变更权。已经持有租约的执行（流程步、重入调用）
  // 不受影响，仍由关闭流程按停止意图收尾；没有 Run 身份的入口（Telegram、
  // 维护更新）也在同一处被拒绝。
  assertExecutionAdmissionOpen(
    'MAA_EXECUTION_SHUTTING_DOWN',
    '服务正在关闭，不再接受新的设备执行'
  );

  const lockPath = getLockPath();
  await mkdir(dirname(lockPath), { recursive: true });
  const metadata: MaaExecutionLeaseMetadata = {
    pid: process.pid,
    source: owner.source || 'maa-command',
    taskName: owner.taskName || null,
    command: owner.command || null,
    startedAt: new Date().toISOString()
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify(metadata, null, 2));
      await handle.close();
      let released = false;
      return {
        owner: metadata,
        lockPath,
        reentrant: false,
        release: async () => {
          if (released) return;
          released = true;
          const currentOwner = await readOwner(lockPath);
          if (!currentOwner || currentOwnerPid(currentOwner) === process.pid) {
            await unlink(lockPath).catch(error => {
              if (errorCodeOf(error) !== 'ENOENT') throw error;
            });
          }
        }
      };
    } catch (error) {
      if (errorCodeOf(error) !== 'EEXIST') throw error;
      const liveOwner = await removeStaleLock(lockPath);
      if (liveOwner) throw new MaaExecutionBusyError(liveOwner);
    }
  }

  throw new MaaExecutionBusyError(normalizeLeaseOwner(await readOwner(lockPath)));
}

/** 释放前复核锁文件仍归本进程；原始 pid 可能不是数字，按严格相等比较。 */
function currentOwnerPid(owner: unknown): unknown {
  return isRecord(owner) ? owner.pid : undefined;
}

export async function withMaaExecutionLease<T>(
  owner: MaaExecutionLeaseRequest,
  callback: (lease: MaaExecutionLease) => T | Promise<T>
): Promise<T> {
  const active = executionContext.getStore();
  if (active?.lease) return callback(active.lease);

  const lease = await acquireMaaExecutionLease(owner);
  const store: ExecutionContextStore = { lease, depth: 1 };
  try {
    return await executionContext.run(store, () => callback(lease));
  } finally {
    await lease.release();
  }
}
