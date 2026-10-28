import { AsyncLocalStorage } from 'async_hooks';
import { mkdir, open, readFile, unlink } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { assertExecutionAdmissionOpen } from './executionAdmissionService.ts';

const serviceDir = dirname(fileURLToPath(import.meta.url));
const defaultLockPath = join(serviceDir, '../data/maa-execution.lock');
const executionContext = new AsyncLocalStorage();

export class MaaExecutionBusyError extends Error {
  constructor(owner = null) {
    super(owner?.taskName ? `MAA 正在执行：${owner.taskName}` : 'MAA 正在被其他任务使用');
    this.name = 'MaaExecutionBusyError';
    this.code = 'MAA_EXECUTION_BUSY';
    this.statusCode = 409;
    this.retryable = true;
    this.owner = owner;
    this.details = { owner };
  }
}

function getLockPath() {
  return process.env.LA_PLUMA_MAA_LOCK_FILE || defaultLockPath;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readOwner(lockPath = getLockPath()) {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeLeaseOwner(owner) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return null;
  const pid = Number(owner.pid);
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    source: typeof owner.source === 'string' ? owner.source : null,
    taskName: typeof owner.taskName === 'string' ? owner.taskName : null,
    command: typeof owner.command === 'string' ? owner.command : null,
    startedAt: typeof owner.startedAt === 'string' ? owner.startedAt : null
  };
}

/**
 * Reports the lease without mutating it. `held` means the recorded owner
 * process is alive; `stale` means the lock file exists but is reclaimable;
 * `unknown` means the file exists but cannot be interpreted.
 */
export async function getMaaExecutionLeaseSnapshot() {
  let raw;
  try {
    raw = await readFile(getLockPath(), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'free', owner: null };
    return { state: 'unknown', owner: null, reason: error?.code || 'read_failed' };
  }

  let parsed;
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

async function removeStaleLock(lockPath) {
  const owner = await readOwner(lockPath);
  if (owner && isProcessAlive(Number(owner.pid))) return owner;
  await unlink(lockPath).catch(error => {
    if (error?.code !== 'ENOENT') throw error;
  });
  return null;
}

export async function acquireMaaExecutionLease(owner = {}) {
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
  const metadata = {
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
          if (!currentOwner || currentOwner.pid === process.pid) {
            await unlink(lockPath).catch(error => {
              if (error?.code !== 'ENOENT') throw error;
            });
          }
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const liveOwner = await removeStaleLock(lockPath);
      if (liveOwner) throw new MaaExecutionBusyError(liveOwner);
    }
  }

  throw new MaaExecutionBusyError(await readOwner(lockPath));
}

export async function withMaaExecutionLease(owner, callback) {
  const active = executionContext.getStore();
  if (active?.lease) return callback(active.lease);

  const lease = await acquireMaaExecutionLease(owner);
  const store = { lease, depth: 1 };
  try {
    return await executionContext.run(store, () => callback(lease));
  } finally {
    await lease.release();
  }
}
