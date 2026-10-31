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
import { randomUUID } from 'crypto';
import { link, mkdir, open, readFile, unlink } from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { assertExecutionAdmissionOpen } from './executionAdmissionService.ts';

const serviceDir = dirname(fileURLToPath(import.meta.url));
const defaultLockPath = join(serviceDir, '../../data/maa-execution.lock');

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

/** 锁文件的读取结果；`unknown` 表示文件存在但无法解释，与“缺失”严格区分。 */
type LeaseFileRead =
  | { state: 'missing' }
  | { state: 'unreadable'; reason: string }
  | { state: 'invalid'; reason: string }
  | { state: 'present'; owner: MaaExecutionOwner };

async function readLeaseFile(lockPath: string): Promise<LeaseFileRead> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') return { state: 'missing' };
    return { state: 'unreadable', reason: errorCodeOf(error) || 'read_failed' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'invalid', reason: 'invalid_json' };
  }
  const owner = normalizeLeaseOwner(parsed);
  // 没有可核实 PID 的记录无法判断持有进程是否存活，按 unknown 拒绝而不是 stale 回收。
  if (!owner || owner.pid === null) return { state: 'invalid', reason: 'invalid_owner' };
  return { state: 'present', owner };
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
  const read = await readLeaseFile(getLockPath());
  if (read.state === 'missing') return { state: 'free', owner: null };
  if (read.state === 'unreadable' || read.state === 'invalid') {
    return { state: 'unknown', owner: null, reason: read.reason };
  }
  return {
    state: isProcessAlive(read.owner.pid) ? 'held' : 'stale',
    owner: read.owner
  };
}

/**
 * 回收一个确认已失效的锁；未知内容一律视为仍被占用并拒绝获取。
 * 返回值只用于 live owner：null 表示可以继续尝试创建，owner 表示锁仍被活进程持有。
 */
async function reclaimLockIfStale(lockPath: string): Promise<MaaExecutionOwner | null> {
  const read = await readLeaseFile(lockPath);
  if (read.state === 'missing') return null;
  if (read.state === 'unreadable' || read.state === 'invalid') {
    // 无法核实的锁不能当作 stale：内容损坏也可能是另一个进程正在写入或持有。
    throw new MaaExecutionBusyError(null);
  }
  if (isProcessAlive(read.owner.pid)) return read.owner;
  await unlink(lockPath).catch(error => {
    if (errorCodeOf(error) !== 'ENOENT') throw error;
  });
  return null;
}

/**
 * 先把完整内容写入同目录临时文件，再用 link() 原子发布为锁文件。
 * link 在目标已存在时返回 EEXIST，因此不会覆盖正在持有的锁；锁文件从出现的第一刻
 * 起就是完整 JSON，不存在“先创建空文件再写入”的可见窗口。
 */
async function publishLockFile(lockPath: string, metadata: MaaExecutionLeaseMetadata): Promise<void> {
  const tempPath = join(
    dirname(lockPath),
    `.${basename(lockPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle: FileHandle | null | undefined;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(metadata, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await link(tempPath, lockPath);
  } finally {
    await handle?.close().catch(() => undefined);
    // 临时文件清理失败不影响已发布的锁；残留的 .tmp 不含锁语义。
    await unlink(tempPath).catch(() => undefined);
  }
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
      await publishLockFile(lockPath, metadata);
      let released = false;
      return {
        owner: metadata,
        lockPath,
        reentrant: false,
        release: async () => {
          if (released) return;
          released = true;
          const current = await readLeaseFile(lockPath);
          // 只删除仍由本进程持有的锁；无法解析的文件不能证明属于自己，保留以免
          // 误删其他进程的租约，由下一次获取按 unknown 拒绝并要求人工确认。
          if (current.state === 'present' && current.owner.pid === process.pid) {
            await unlink(lockPath).catch(error => {
              if (errorCodeOf(error) !== 'ENOENT') throw error;
            });
          }
        }
      };
    } catch (error) {
      if (errorCodeOf(error) !== 'EEXIST') throw error;
      const liveOwner = await reclaimLockIfStale(lockPath);
      if (liveOwner) throw new MaaExecutionBusyError(liveOwner);
    }
  }

  const read = await readLeaseFile(lockPath);
  throw new MaaExecutionBusyError(read.state === 'present' ? read.owner : null);
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
