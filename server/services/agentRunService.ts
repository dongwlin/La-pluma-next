/**
 * Agent Run 记录、幂等与持久化
 *
 * Run 是执行身份与终态的唯一来源（见 docs/architecture/execution-lifecycle.md）。
 * 本模块只维护记录本身：创建/转换/停止意图/幂等与磁盘快照；设备租约、子进程与
 * 流程进度是另外的投影，由调用方组合。
 *
 * 类型边界：
 * - 生命周期状态是有穷联合，写入路径只接受已建模的转换；
 * - 磁盘快照从 `unknown` 逐字段校验；身份、状态、时间戳与序号不合法时 fail-closed，
 *   不删除文件、不绕开准入；
 * - 存储版本保持 `version: 1`，本模块不迁移旧格式。
 */

import { createHash, randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { agentError } from '../utils/apiHelper.ts';
import type { AgentError } from '../utils/apiHelper.ts';
import { readJsonFile, writeJsonFile } from '../utils/fileHelper.ts';
import { createLogger } from '../utils/logger.ts';
import { waitWithAbort } from '../utils/abort.ts';
import { assertExecutionAdmissionOpen } from './executionAdmissionService.ts';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$/;
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_TERMINAL_RUNS = 500;
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'stopped', 'interrupted']);
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['accepted', 'waiting', 'running', 'stopping']);
const ALL_STATUSES: ReadonlySet<string> = new Set([...TERMINAL_STATUSES, ...ACTIVE_STATUSES]);
const AGENT_RUN_STORE_VERSION = 1;
const DEFAULT_AGENT_RUN_STORE_PATH = fileURLToPath(new URL('../data/agent-runs.json', import.meta.url));
const logger = createLogger('AgentRunService');

/** 活动状态：`accepted`/`waiting` 不持有执行权，`running`/`stopping` 持有到退出。 */
export type AgentRunActiveStatus = 'accepted' | 'waiting' | 'running' | 'stopping';
/** 终态：写入后不可变，重复写入同一终态是幂等的。 */
export type AgentRunTerminalStatus = 'succeeded' | 'failed' | 'stopped' | 'interrupted';
export type AgentRunStatus = AgentRunActiveStatus | AgentRunTerminalStatus;

/** 停止意图的处理方式，仅用于调用方分流；不是 Run 状态。 */
export type AgentRunStopDisposition = 'terminal' | 'canceled' | 'stopping';

/** 结构化失败；`failed` 与 `interrupted` 必须携带。 */
export interface AgentRunError {
  code: string;
  message: string;
  statusCode: number;
  details: Record<string, unknown>;
  retryable: boolean;
}

export interface AgentRunLinks {
  self: string;
  stop: string;
}

/** 重启恢复边界，仅 `interrupted` 存在。 */
export interface AgentRunRecovery {
  source: string;
  previousState: string | null;
  executionResumed: false;
  deviceState: 'unknown';
}

/**
 * 对外的 Run DTO。字段可变是因为每次读取都返回深拷贝，调用方（包括既有测试）
 * 可以像操作普通对象一样修改返回值，不会影响存储。
 */
export interface AgentRunDto {
  runId: string;
  operationId: string;
  state: AgentRunStatus;
  acceptedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: unknown;
  links: AgentRunLinks;
  durationMs?: number;
  progress?: unknown;
  error?: AgentRunError;
  recovery?: AgentRunRecovery;
}

/** 内存与磁盘共用的 Run 记录（内部字段不进入 DTO）。 */
export interface AgentRunRecord {
  runId: string;
  operationId: string;
  idempotencyKey: string | null;
  inputFingerprint: string;
  input: unknown;
  metadata: unknown;
  status: AgentRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  result: unknown;
  error: AgentRunError | null;
  /** 读取时追加的进度投影不持久化；保留字段以兼容既有 DTO 分支。 */
  progress?: unknown;
}

export interface AgentRunStoreRecord {
  run: AgentRunRecord;
  sequence: number;
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  terminalSequence: number | null;
}

export interface AgentRunStoreSnapshot {
  version: number;
  savedAt: string;
  runs: AgentRunStoreRecord[];
}

export interface AgentRunStoreStatus {
  enabled: boolean;
  required: boolean;
  ready: boolean;
  dirty: boolean;
  filePath: string;
  error: string | null;
}

export interface AgentRunStoreRestoreSummary {
  filePath: string;
  restoredRuns: number;
  interruptedRuns: number;
  prunedRuns: number;
}

export type AgentRunStoreReader = (filePath: string, defaultValue: unknown) => Promise<unknown>;
export type AgentRunStoreWriter = (filePath: string, data: unknown, pretty?: boolean) => Promise<void>;

export interface AgentRunStoreLogger {
  info(message: string, data?: unknown): unknown;
  error(message: string, data?: unknown): unknown;
}

export interface AgentRunStoreOverrides {
  signal?: AbortSignal;
  filePath?: string;
  readStore?: AgentRunStoreReader;
  writeStore?: AgentRunStoreWriter;
  runtimeLogger?: AgentRunStoreLogger;
}

export interface BeginAgentRunParams {
  operationId: string;
  /** 调用方可能传入任意请求头值；由 normalizeIdempotencyKey 按既有规则收窄或拒绝。 */
  idempotencyKey?: unknown;
  input?: unknown;
  metadata?: unknown;
}

export interface BeginAgentRunResult {
  run: AgentRunDto;
  replayed: boolean;
}

export interface AgentRunStopResult {
  run: AgentRunDto;
  disposition: AgentRunStopDisposition;
}

export interface ListAgentRunsQuery {
  operationId?: string | null;
  state?: AgentRunStatus | null;
  status?: AgentRunStatus | null;
  limit?: number;
}

interface PersistenceState {
  enabled: boolean;
  required: boolean;
  filePath: string;
  readStore: AgentRunStoreReader;
  writeStore: AgentRunStoreWriter;
  runtimeLogger: AgentRunStoreLogger;
}

const runs = new Map<string, AgentRunStoreRecord>();
const idempotencyIndex = new Map<string, { runId: string; inputFingerprint: string }>();
let sequence = 0;
let terminalSequence = 0;
let persistence: PersistenceState = {
  enabled: false,
  required: false,
  filePath: DEFAULT_AGENT_RUN_STORE_PATH,
  readStore: readJsonFile,
  writeStore: writeJsonFile,
  runtimeLogger: logger
};
let persistenceDirty = false;
let persistencePromise: Promise<void> | null = null;
let persistenceError: unknown = null;
let persistenceStartQueued = false;
let persistenceGeneration = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truthyOrNull(value: unknown): unknown {
  return value ? value : null;
}

function describeError(error: unknown): string {
  if (isRecord(error) && error.message) return String(error.message);
  return String(error);
}

function errorCodeOf(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function isTerminalStatus(status: string): status is AgentRunTerminalStatus {
  return TERMINAL_STATUSES.has(status);
}

function isActiveStatus(status: string): status is AgentRunActiveStatus {
  return ACTIVE_STATUSES.has(status);
}

function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return typeof value === 'string' && ALL_STATUSES.has(value);
}

function agentRunPersistenceError(error: unknown): AgentError {
  return agentError('AGENT_RUN_PERSISTENCE_FAILED', `Agent run 持久化失败: ${describeError(error)}`, {
    statusCode: 503,
    details: { filePath: persistence.filePath },
    retryable: true
  });
}

function persistenceErrorMessage(): string | null {
  if (!isRecord(persistenceError) || !persistenceError.message) return null;
  return String(persistenceError.message);
}

function assertAgentRunStoreReadable(): void {
  if (persistence.required && !persistence.enabled) {
    throw agentRunPersistenceError(persistenceError || new Error('Agent run 存储尚未就绪'));
  }
}

function buildStoreSnapshot(): AgentRunStoreSnapshot {
  return {
    version: AGENT_RUN_STORE_VERSION,
    savedAt: new Date().toISOString(),
    runs: [...runs.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map(record => ({
        run: cloneJson(record.run),
        sequence: record.sequence,
        createdAtMs: record.createdAtMs,
        startedAtMs: record.startedAtMs,
        finishedAtMs: record.finishedAtMs,
        terminalSequence: record.terminalSequence
      }))
  };
}

function startPersistenceWriter(): Promise<void> | null {
  if (!persistence.enabled || persistencePromise || !persistenceDirty) return persistencePromise;

  const generation = persistenceGeneration;
  const activePersistence = persistence;
  const writer = (async () => {
    while (generation === persistenceGeneration && persistenceDirty) {
      persistenceDirty = false;
      try {
        await activePersistence.writeStore(activePersistence.filePath, buildStoreSnapshot());
        if (generation !== persistenceGeneration) break;
        persistenceError = null;
      } catch (error) {
        if (generation !== persistenceGeneration) break;
        persistenceDirty = true;
        persistenceError = error;
        activePersistence.runtimeLogger.error('Agent run 持久化失败', {
          filePath: activePersistence.filePath,
          error: describeError(error)
        });
        break;
      }
    }
  });
  const settled: Promise<void> = writer().finally(() => {
    if (persistencePromise !== settled) return;
    persistencePromise = null;
    if (generation === persistenceGeneration
      && persistence.enabled
      && persistenceDirty
      && !persistenceError) {
      startPersistenceWriter();
    }
  });
  persistencePromise = settled;
  return settled;
}

function scheduleAgentRunPersistence(): void {
  if (!persistence.enabled) return;
  persistenceDirty = true;
  if (persistencePromise || persistenceStartQueued) return;
  const generation = persistenceGeneration;
  persistenceStartQueued = true;
  queueMicrotask(() => {
    if (generation !== persistenceGeneration) return;
    persistenceStartQueued = false;
    startPersistenceWriter();
  });
}

export async function flushAgentRunStore(): Promise<{ persisted: boolean; filePath: string }> {
  if (!persistence.enabled) {
    if (persistence.required) {
      throw agentRunPersistenceError(persistenceError || new Error('Agent run 存储尚未就绪'));
    }
    return { persisted: false, filePath: persistence.filePath };
  }

  while (true) {
    const pending = startPersistenceWriter();
    if (pending) await pending;
    if (persistenceError) throw agentRunPersistenceError(persistenceError);
    if (!persistenceDirty && !persistencePromise) {
      return { persisted: true, filePath: persistence.filePath };
    }
  }
}

export async function withFlushedAgentRunSnapshot<T>(
  runId: string,
  consume: (run: AgentRunDto | null) => T
): Promise<T> {
  while (true) {
    await flushAgentRunStore();
    const run = getAgentRun(runId);
    if (!persistenceDirty && !persistencePromise) return consume(run);
  }
}

export function getAgentRunStoreStatus(): AgentRunStoreStatus {
  return {
    enabled: persistence.enabled,
    required: persistence.required,
    ready: persistence.enabled && !persistenceError,
    dirty: persistenceDirty,
    filePath: persistence.filePath,
    error: persistenceErrorMessage()
  };
}

function validationError(code: string, message: string, details: Record<string, unknown> = {}): AgentError {
  return agentError(code, message, {
    statusCode: 400,
    details,
    retryable: false
  });
}

function normalizeJson(value: unknown, fieldName: string): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError(`${fieldName} 不是可序列化的 JSON 值`);
    }
    return JSON.parse(serialized);
  } catch (error) {
    throw validationError(
      'AGENT_RUN_JSON_INVALID',
      `${fieldName} 必须是可序列化的 JSON`,
      { field: fieldName, reason: describeError(error) }
    );
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

export function fingerprintAgentRunInput(input: unknown = {}): string {
  const normalized = normalizeJson(input, 'input');
  return createHash('sha256').update(stableJson(normalized)).digest('hex');
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toAgentRunDto(run: AgentRunRecord): AgentRunDto;
function toAgentRunDto(run: AgentRunRecord | null | undefined): AgentRunDto | null;
function toAgentRunDto(run: AgentRunRecord | null | undefined): AgentRunDto | null {
  if (!run) return null;

  const dto: AgentRunDto = {
    runId: run.runId,
    operationId: run.operationId,
    state: run.status,
    acceptedAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    result: cloneJson(run.result),
    links: {
      self: `/api/agent/runs/${run.runId}`,
      stop: `/api/agent/actions/stop?runId=${encodeURIComponent(run.runId)}`
    }
  };
  if (run.durationMs !== null) dto.durationMs = run.durationMs;
  if (run.progress) dto.progress = cloneJson(run.progress);
  if (run.error) {
    dto.error = {
      code: run.error.code,
      message: run.error.message,
      details: cloneJson(run.error.details),
      retryable: run.error.retryable,
      statusCode: run.error.statusCode
    };
  }
  if (run.status === 'interrupted') {
    dto.recovery = {
      source: stringField(run.error?.details.reason) || 'unknown',
      previousState: stringField(run.error?.details.previousState) || null,
      executionResumed: false,
      deviceState: 'unknown'
    };
  }
  return cloneJson(dto);
}

/** 读取已持久化的可选字符串字段；非字符串按缺失处理，不把任意外部值透传到公开 DTO。 */
function stringField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function idempotencyIndexKey(operationId: string, idempotencyKey: string): string {
  return JSON.stringify([operationId, idempotencyKey]);
}

function removeRecord(runId: string): boolean {
  const record = runs.get(runId);
  if (!record) return false;

  runs.delete(runId);
  if (record.run.idempotencyKey) {
    const indexKey = idempotencyIndexKey(record.run.operationId, record.run.idempotencyKey);
    if (idempotencyIndex.get(indexKey)?.runId === runId) idempotencyIndex.delete(indexKey);
  }
  return true;
}

function terminalFinishedAt(record: AgentRunStoreRecord): number {
  // 终态记录在写入与恢复时都要求 finishedAtMs，这里只把类型收窄到 number。
  return record.finishedAtMs ?? 0;
}

function pruneTerminalRuns(now: number = Date.now()): number {
  const cutoff = now - TERMINAL_RETENTION_MS;
  const retained: AgentRunStoreRecord[] = [];
  let removed = 0;

  for (const [runId, record] of runs) {
    if (!isTerminalStatus(record.run.status)) continue;
    if (terminalFinishedAt(record) <= cutoff) {
      if (removeRecord(runId)) removed += 1;
      continue;
    }
    retained.push(record);
  }

  if (retained.length <= MAX_TERMINAL_RUNS) return removed;
  retained.sort((left, right) =>
    terminalFinishedAt(left) - terminalFinishedAt(right)
    || (left.terminalSequence ?? 0) - (right.terminalSequence ?? 0)
  );
  for (const record of retained.slice(0, retained.length - MAX_TERMINAL_RUNS)) {
    if (removeRecord(record.run.runId)) removed += 1;
  }
  return removed;
}

function normalizeOperationId(operationId: unknown): string {
  if (typeof operationId !== 'string' || !operationId.trim()) {
    throw validationError(
      'AGENT_RUN_OPERATION_REQUIRED',
      'operationId 不能为空',
      { operationId }
    );
  }
  return operationId.trim();
}

function normalizeIdempotencyKey(idempotencyKey: unknown): string | null {
  if (idempotencyKey === undefined || idempotencyKey === null) return null;
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw validationError(
      'AGENT_IDEMPOTENCY_KEY_INVALID',
      'idempotencyKey 格式不合法',
      { idempotencyKey, pattern: IDEMPOTENCY_KEY_PATTERN.source }
    );
  }
  return idempotencyKey;
}

function requireRecord(runId: string): AgentRunStoreRecord {
  if (pruneTerminalRuns() > 0) scheduleAgentRunPersistence();
  const record = runs.get(runId);
  if (!record) {
    throw agentError('AGENT_RUN_NOT_FOUND', `未找到 Agent run: ${runId}`, {
      statusCode: 404,
      details: { runId },
      retryable: false
    });
  }
  return record;
}

function transitionError(
  record: AgentRunStoreRecord,
  targetStatus: string,
  allowedStatuses: readonly string[]
): AgentError {
  return agentError('AGENT_RUN_STATE_CONFLICT', `无法将 run 从 ${record.run.status} 更新为 ${targetStatus}`, {
    statusCode: 409,
    details: {
      runId: record.run.runId,
      status: record.run.status,
      targetStatus,
      allowedStatuses
    },
    retryable: false
  });
}

function transition(
  runId: string,
  targetStatus: AgentRunStatus,
  allowedStatuses: readonly AgentRunStatus[],
  updates: Partial<AgentRunRecord> = {}
): AgentRunDto {
  const record = requireRecord(runId);
  if (record.run.status === targetStatus) return toAgentRunDto(record.run);
  if (!allowedStatuses.includes(record.run.status)) {
    throw transitionError(record, targetStatus, allowedStatuses);
  }

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  record.run.status = targetStatus;
  record.run.updatedAt = now;
  Object.assign(record.run, updates);

  if (targetStatus === 'running' && !record.run.startedAt) {
    record.run.startedAt = now;
    record.startedAtMs = nowMs;
  }

  if (isTerminalStatus(targetStatus)) {
    record.run.finishedAt = now;
    record.run.durationMs = Math.max(0, nowMs - (record.startedAtMs ?? record.createdAtMs));
    record.finishedAtMs = nowMs;
    record.terminalSequence = ++terminalSequence;
    pruneTerminalRuns(nowMs);
  }

  scheduleAgentRunPersistence();
  return toAgentRunDto(record.run);
}

/** 持久化错误对象只保证公开字段；缺省或类型不符时回退到稳定的默认值。 */
function normalizeErrorFields(value: unknown): AgentRunError {
  const record = isRecord(value) ? value : {};
  return {
    code: typeof record.code === 'string' && record.code ? record.code : 'AGENT_RUN_FAILED',
    message: typeof record.message === 'string' && record.message ? record.message : 'Agent run 执行失败',
    statusCode: normalizeFailureStatusCode(record.statusCode ?? record.status),
    details: isRecord(record.details) ? record.details : {},
    retryable: typeof record.retryable === 'boolean' ? record.retryable : false
  };
}

function normalizeFailure(error: unknown): AgentRunError {
  if (error instanceof Error) {
    const fields = error as Error & {
      code?: unknown;
      statusCode?: unknown;
      status?: unknown;
      details?: unknown;
      retryable?: unknown;
    };
    return normalizeErrorFields(normalizeJson({
      code: fields.code || 'AGENT_RUN_FAILED',
      message: fields.message,
      statusCode: normalizeFailureStatusCode(fields.statusCode || fields.status),
      details: fields.details || {},
      retryable: fields.retryable ?? false
    }, 'error'));
  }
  const normalized = normalizeJson(error ?? { message: 'Agent run 执行失败' }, 'error');
  if (typeof normalized === 'string') {
    return { code: 'AGENT_RUN_FAILED', message: normalized, statusCode: 500, details: {}, retryable: false };
  }
  return normalizeErrorFields(normalized);
}

function normalizeFailureStatusCode(statusCode: unknown): number {
  const normalized = Number(statusCode);
  return Number.isInteger(normalized) && normalized >= 400 && normalized <= 599 ? normalized : 500;
}

function storeValidationError(message: string, details: Record<string, unknown> = {}): AgentError {
  return agentError('AGENT_RUN_STORE_INVALID', message, {
    statusCode: 503,
    details: { filePath: persistence.filePath, ...details },
    retryable: false
  });
}

function finiteTimestamp(value: unknown, fallback: unknown, field: string, index: number): number {
  const normalized = Number(value ?? fallback);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw storeValidationError(`Agent run 存储中的 ${field} 无效`, { index, field });
  }
  return normalized;
}

/**
 * 从 unknown 恢复一条磁盘记录。身份、状态、时间戳与序号决定准入是否关闭；
 * 其余字段按类型边界归一化，已由本模块写出的记录不受影响。
 */
function restoreRecord(item: unknown, index: number): AgentRunStoreRecord {
  if (!isRecord(item) || !item.run || typeof item.run !== 'object') {
    throw storeValidationError('Agent run 存储记录格式无效', { index });
  }

  const storedRun = normalizeJson(item.run, `runs[${index}].run`);
  if (!isRecord(storedRun)
    || typeof storedRun.runId !== 'string' || !storedRun.runId
    || typeof storedRun.operationId !== 'string' || !storedRun.operationId
    || !isAgentRunStatus(storedRun.status)
    || typeof storedRun.createdAt !== 'string' || !Number.isFinite(Date.parse(storedRun.createdAt))) {
    throw storeValidationError('Agent run 存储记录缺少有效的身份或状态字段', {
      index,
      runId: truthyOrNull(isRecord(storedRun) ? storedRun.runId : null)
    });
  }
  const runId: string = storedRun.runId;
  const operationId: string = storedRun.operationId;
  const status: AgentRunStatus = storedRun.status;
  const createdAt: string = storedRun.createdAt;

  const idempotencyKey = storedRun.idempotencyKey;
  if (idempotencyKey !== null && idempotencyKey !== undefined
    && (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey))) {
    throw storeValidationError('Agent run 存储中的幂等键无效', { index, runId });
  }
  if (idempotencyKey && typeof storedRun.inputFingerprint !== 'string') {
    throw storeValidationError('Agent run 存储缺少请求指纹', { index, runId });
  }

  const terminal = isTerminalStatus(status);
  const active = isActiveStatus(status);
  if (typeof storedRun.updatedAt !== 'string' || !Number.isFinite(Date.parse(storedRun.updatedAt))) {
    throw storeValidationError('Agent run 存储中的 updatedAt 无效', { index, runId });
  }
  if (storedRun.startedAt !== null && storedRun.startedAt !== undefined
    && (typeof storedRun.startedAt !== 'string' || !Number.isFinite(Date.parse(storedRun.startedAt)))) {
    throw storeValidationError('Agent run 存储中的 startedAt 无效', { index, runId });
  }
  if (terminal && (typeof storedRun.finishedAt !== 'string' || !Number.isFinite(Date.parse(storedRun.finishedAt)))) {
    throw storeValidationError('Agent run 终态记录缺少有效的 finishedAt', { index, runId });
  }
  if (active && storedRun.finishedAt !== null && storedRun.finishedAt !== undefined) {
    throw storeValidationError('Agent run 活跃记录不能包含 finishedAt', { index, runId });
  }
  if ((status === 'failed' || status === 'interrupted')
    && (!storedRun.error || typeof storedRun.error !== 'object' || Array.isArray(storedRun.error))) {
    throw storeValidationError('Agent run 失败终态缺少错误信息', { index, runId });
  }

  const startedAt = typeof storedRun.startedAt === 'string' ? storedRun.startedAt : null;
  const finishedAt = typeof storedRun.finishedAt === 'string' ? storedRun.finishedAt : null;
  const run: AgentRunRecord = {
    runId,
    operationId,
    idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : null,
    inputFingerprint: typeof storedRun.inputFingerprint === 'string' ? storedRun.inputFingerprint : '',
    input: storedRun.input ?? {},
    metadata: storedRun.metadata ?? {},
    status,
    createdAt,
    updatedAt: storedRun.updatedAt,
    startedAt,
    finishedAt,
    durationMs: typeof storedRun.durationMs === 'number' ? storedRun.durationMs : null,
    result: storedRun.result ?? null,
    error: storedRun.error === null || storedRun.error === undefined
      ? null
      : normalizeErrorFields(storedRun.error)
  };

  const createdAtMs = finiteTimestamp(item.createdAtMs, Date.parse(createdAt), 'createdAtMs', index);
  const startedAtMs = startedAt
    ? finiteTimestamp(item.startedAtMs, Date.parse(startedAt), 'startedAtMs', index)
    : null;
  if (terminal && (item.finishedAtMs === null || item.finishedAtMs === undefined)) {
    throw storeValidationError('Agent run 终态记录缺少 finishedAtMs', { index, runId });
  }
  const finishedAtMs = terminal
    ? finiteTimestamp(item.finishedAtMs, undefined, 'finishedAtMs', index)
    : null;
  const storedSequence = Number(item.sequence);
  if (!Number.isInteger(storedSequence) || storedSequence <= 0) {
    throw storeValidationError('Agent run 存储中的 sequence 无效', { index, runId });
  }
  const storedTerminalSequence = item.terminalSequence === null || item.terminalSequence === undefined
    ? null
    : Number(item.terminalSequence);
  if (terminal && (!Number.isInteger(storedTerminalSequence) || (storedTerminalSequence ?? 0) <= 0)) {
    throw storeValidationError('Agent run 终态记录缺少有效的 terminalSequence', { index, runId });
  }
  if (active && storedTerminalSequence !== null) {
    throw storeValidationError('Agent run 活跃记录不能包含 terminalSequence', { index, runId });
  }
  if (startedAtMs !== null && startedAtMs < createdAtMs) {
    throw storeValidationError('Agent run 的 startedAt 早于 createdAt', { index, runId });
  }
  if (finishedAtMs !== null && finishedAtMs < (startedAtMs ?? createdAtMs)) {
    throw storeValidationError('Agent run 的 finishedAt 早于开始时间', { index, runId });
  }

  return {
    run,
    sequence: storedSequence,
    createdAtMs,
    startedAtMs,
    finishedAtMs,
    terminalSequence: storedTerminalSequence
  };
}

interface RestoredStore {
  records: AgentRunStoreRecord[];
  sequence: number;
  terminalSequence: number;
  interruptedRuns: number;
}

function restoreStoreSnapshot(snapshot: unknown, nowMs: number = Date.now()): RestoredStore {
  const normalized = snapshot;
  if (!isRecord(normalized)
    || normalized.version !== AGENT_RUN_STORE_VERSION
    || !Array.isArray(normalized.runs)) {
    throw storeValidationError('Agent run 存储版本或顶层格式无效', {
      expectedVersion: AGENT_RUN_STORE_VERSION,
      actualVersion: isRecord(normalized) ? normalized.version ?? null : null
    });
  }

  const restoredRecords = normalized.runs.map(restoreRecord);
  const runIds = new Set<string>();
  const sequences = new Set<number>();
  const terminalSequences = new Set<number>();
  const idempotencyKeys = new Set<string>();
  let restoredSequence = 0;
  let restoredTerminalSequence = 0;
  let interruptedRuns = 0;
  const now = new Date(nowMs).toISOString();

  for (const record of restoredRecords) {
    const { run } = record;
    if (runIds.has(run.runId)) {
      throw storeValidationError('Agent run 存储包含重复 runId', { runId: run.runId });
    }
    runIds.add(run.runId);
    if (sequences.has(record.sequence)) {
      throw storeValidationError('Agent run 存储包含重复 sequence', { sequence: record.sequence });
    }
    sequences.add(record.sequence);
    if (record.terminalSequence !== null) {
      if (terminalSequences.has(record.terminalSequence)) {
        throw storeValidationError('Agent run 存储包含重复 terminalSequence', {
          terminalSequence: record.terminalSequence
        });
      }
      terminalSequences.add(record.terminalSequence);
    }
    restoredSequence = Math.max(restoredSequence, record.sequence);
    restoredTerminalSequence = Math.max(restoredTerminalSequence, record.terminalSequence || 0);

    if (run.idempotencyKey) {
      const indexKey = idempotencyIndexKey(run.operationId, run.idempotencyKey);
      if (idempotencyKeys.has(indexKey)) {
        throw storeValidationError('Agent run 存储包含重复幂等键', {
          operationId: run.operationId,
          idempotencyKey: run.idempotencyKey
        });
      }
      idempotencyKeys.add(indexKey);
    }
  }

  for (const record of restoredRecords) {
    if (!isActiveStatus(record.run.status)) continue;
    const previousState: AgentRunActiveStatus = record.run.status;
    record.run.status = 'interrupted';
    record.run.updatedAt = now;
    record.run.finishedAt = now;
    record.run.durationMs = Math.max(0, nowMs - (record.startedAtMs ?? record.createdAtMs));
    record.run.error = {
      code: 'AGENT_RUN_INTERRUPTED',
      message: '服务重启时该执行尚未结束，已标记为中断且不会自动续跑',
      statusCode: 503,
      details: { reason: 'server_restart', previousState },
      retryable: false
    };
    record.finishedAtMs = nowMs;
    record.terminalSequence = ++restoredTerminalSequence;
    interruptedRuns += 1;
  }

  return {
    records: restoredRecords,
    sequence: restoredSequence,
    terminalSequence: restoredTerminalSequence,
    interruptedRuns
  };
}

export async function initializeAgentRunStore(
  overrides: AgentRunStoreOverrides = {}
): Promise<AgentRunStoreRestoreSummary> {
  const { signal } = overrides;
  signal?.throwIfAborted();
  if (persistencePromise) await waitWithAbort(() => persistencePromise, signal);
  signal?.throwIfAborted();

  persistenceGeneration += 1;
  persistence = {
    enabled: false,
    required: true,
    filePath: overrides.filePath || process.env.LA_PLUMA_AGENT_RUN_STORE || DEFAULT_AGENT_RUN_STORE_PATH,
    readStore: overrides.readStore || readJsonFile,
    writeStore: overrides.writeStore || writeJsonFile,
    runtimeLogger: overrides.runtimeLogger || logger
  };
  persistenceDirty = false;
  persistenceError = null;
  persistenceStartQueued = false;

  let restored: RestoredStore;
  try {
    const snapshot = await waitWithAbort(() => persistence.readStore(persistence.filePath, {
      version: AGENT_RUN_STORE_VERSION,
      runs: []
    }), signal);
    signal?.throwIfAborted();
    restored = restoreStoreSnapshot(snapshot);
  } catch (error) {
    persistenceError = error;
    signal?.throwIfAborted();
    persistence.runtimeLogger.error('Agent run 存储恢复失败，执行接口将保持关闭', {
      filePath: persistence.filePath,
      error: describeError(error)
    });
    throw errorCodeOf(error) === 'AGENT_RUN_STORE_INVALID' ? error : agentRunPersistenceError(error);
  }

  runs.clear();
  idempotencyIndex.clear();
  for (const record of restored.records) {
    runs.set(record.run.runId, record);
    if (record.run.idempotencyKey) {
      idempotencyIndex.set(idempotencyIndexKey(record.run.operationId, record.run.idempotencyKey), {
        runId: record.run.runId,
        inputFingerprint: record.run.inputFingerprint
      });
    }
  }
  sequence = restored.sequence;
  terminalSequence = restored.terminalSequence;
  const prunedRuns = pruneTerminalRuns();

  persistence.enabled = true;
  scheduleAgentRunPersistence();
  // 已提交的原子写入由持久化队列完成；取消后不再宣布初始化成功。
  await waitWithAbort(() => flushAgentRunStore(), signal);
  signal?.throwIfAborted();
  persistence.runtimeLogger.info('Agent run 存储恢复完成', {
    filePath: persistence.filePath,
    restoredRuns: runs.size,
    interruptedRuns: restored.interruptedRuns,
    prunedRuns
  });
  return {
    filePath: persistence.filePath,
    restoredRuns: runs.size,
    interruptedRuns: restored.interruptedRuns,
    prunedRuns
  };
}

export async function shutdownAgentRunStoreForTests(
  { clearMemory = true }: { clearMemory?: boolean } = {}
): Promise<void> {
  let flushError: unknown = null;
  try {
    if (persistence.enabled) await flushAgentRunStore();
  } catch (error) {
    flushError = error;
  } finally {
    resetAgentRunState({ clearMemory });
  }
  if (flushError) throw flushError;
}

export function beginAgentRun({
  operationId,
  idempotencyKey = null,
  input = {},
  metadata = {}
  // 缺省值只保留既有调用边界（空参数仍走 operationId 校验），由 normalizeOperationId 拒绝。
}: BeginAgentRunParams = {} as BeginAgentRunParams): BeginAgentRunResult {
  // 关闭开始后不再创建新的执行身份；这是所有纳入 Run 的入口（HTTP、cron、
  // 作业集）共用的准入点，早于幂等重放与落库，避免关闭期间写入新的执行意图。
  assertExecutionAdmissionOpen(
    'AGENT_EXECUTION_SHUTTING_DOWN',
    '服务正在关闭，不再接受新的设备执行'
  );
  if (persistence.required && !persistence.enabled) {
    throw agentRunPersistenceError(persistenceError || new Error('Agent run 存储尚未就绪'));
  }
  if (pruneTerminalRuns() > 0) scheduleAgentRunPersistence();

  const normalizedOperationId = normalizeOperationId(operationId);
  const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey);
  const normalizedInput = normalizeJson(input, 'input');
  const normalizedMetadata = normalizeJson(metadata, 'metadata');
  const inputFingerprint = createHash('sha256').update(stableJson(normalizedInput)).digest('hex');

  if (normalizedIdempotencyKey) {
    const indexKey = idempotencyIndexKey(normalizedOperationId, normalizedIdempotencyKey);
    const existing = idempotencyIndex.get(indexKey);
    if (existing) {
      const record = runs.get(existing.runId);
      if (record && existing.inputFingerprint === inputFingerprint) {
        return { run: toAgentRunDto(record.run), replayed: true };
      }
      if (record) {
        throw agentError('AGENT_IDEMPOTENCY_KEY_REUSED', '同一 operation 的幂等键不能用于不同输入', {
          statusCode: 409,
          details: {
            operationId: normalizedOperationId,
            idempotencyKey: normalizedIdempotencyKey,
            runId: existing.runId,
            existingFingerprint: existing.inputFingerprint,
            inputFingerprint
          },
          retryable: false
        });
      }
      idempotencyIndex.delete(indexKey);
    }
  }

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const run: AgentRunRecord = {
    runId: randomUUID(),
    operationId: normalizedOperationId,
    idempotencyKey: normalizedIdempotencyKey,
    inputFingerprint,
    input: normalizedInput,
    metadata: normalizedMetadata,
    status: 'accepted',
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    result: null,
    error: null
  };
  const record: AgentRunStoreRecord = {
    run,
    sequence: ++sequence,
    createdAtMs: nowMs,
    startedAtMs: null,
    finishedAtMs: null,
    terminalSequence: null
  };
  runs.set(run.runId, record);

  if (normalizedIdempotencyKey) {
    idempotencyIndex.set(idempotencyIndexKey(normalizedOperationId, normalizedIdempotencyKey), {
      runId: run.runId,
      inputFingerprint
    });
  }

  scheduleAgentRunPersistence();
  return { run: toAgentRunDto(run), replayed: false };
}

export function startAgentRun(runId: string): AgentRunDto {
  return transition(runId, 'running', ['accepted']);
}

/**
 * Gate used by executors after they obtain execution rights and before any
 * device side effect. A run stopped while still pending must not start.
 * A waiting run (a manual copilot-set between entries) re-enters execution.
 */
export function startAgentRunForExecution(runId: string): AgentRunDto {
  const record = requireRecord(runId);
  if (record.run.status === 'accepted') return startAgentRun(runId);
  if (record.run.status === 'waiting') return transition(runId, 'running', ['waiting']);
  if (record.run.status === 'running') return toAgentRunDto(record.run);

  const error = agentError(
    'AGENT_RUN_STOPPED_BEFORE_START',
    '执行在开始前已被停止，未向设备发送任何命令',
    {
      statusCode: 409,
      details: { runId, state: record.run.status },
      retryable: false
    }
  ) as AgentError & { stopped?: boolean };
  error.stopped = true;
  throw error;
}

/**
 * Returns a running copilot-set run to the explicit waiting-for-next phase.
 * Only multi-step executors use this; a waiting run holds no execution lease.
 */
export function markAgentRunWaiting(runId: string): AgentRunDto {
  return transition(runId, 'waiting', ['running']);
}

export function markAgentRunStopping(runId: string): AgentRunDto {
  return transition(runId, 'stopping', ['accepted', 'running']);
}

/**
 * 设备持有状态：只有 running/stopping 持有执行租约并拥有设备变更权。
 * 快照的 current 必须先按这个集合对齐，不能仅按状态优先级排序：滞留在
 * stopping 的旧 run 不能压过之后真正 running 的新 run，否则全局停止会
 * 把设备命令发给新 run 却只记录旧 run 的停止意图。
 */
export function isDeviceOwningAgentRunStatus(status: AgentRunStatus): boolean {
  return status === 'running' || status === 'stopping';
}

/** 非设备持有意图的相对顺序；accepted 比 waiting 更接近执行权。 */
const PENDING_RUN_PRIORITY: Record<'accepted' | 'waiting', number> = {
  accepted: 2,
  waiting: 1
};

/** 活动 run 排序：设备持有者优先（按开始时间取最新），其余 accepted 优先于 waiting。 */
function compareActiveRuns(left: AgentRunStoreRecord, right: AgentRunStoreRecord): number {
  const leftOwning = isDeviceOwningAgentRunStatus(left.run.status);
  const rightOwning = isDeviceOwningAgentRunStatus(right.run.status);
  if (leftOwning !== rightOwning) return leftOwning ? -1 : 1;

  if (leftOwning) {
    const startedDelta = (right.startedAtMs ?? 0) - (left.startedAtMs ?? 0);
    if (startedDelta !== 0) return startedDelta;
  } else {
    const leftPending = left.run.status as 'accepted' | 'waiting';
    const rightPending = right.run.status as 'accepted' | 'waiting';
    const priorityDelta = PENDING_RUN_PRIORITY[rightPending] - PENDING_RUN_PRIORITY[leftPending];
    if (priorityDelta !== 0) return priorityDelta;
  }

  return right.sequence - left.sequence;
}

/**
 * Records a stop intent for one run without sending any device command.
 * `accepted` and `waiting` runs hold no execution rights, so they become
 * terminal immediately; `running` runs move to `stopping`; `stopping` is
 * idempotent.
 */
export function requestAgentRunStop(runId: string): AgentRunStopResult {
  const record = requireRecord(runId);
  const state = record.run.status;

  if (isTerminalStatus(state)) {
    return { run: toAgentRunDto(record.run), disposition: 'terminal' };
  }
  if (state === 'accepted') {
    return {
      run: stopAgentRun(runId, { canceled: true, reason: 'stop_requested_before_start' }),
      disposition: 'canceled'
    };
  }
  if (state === 'waiting') {
    return {
      run: stopAgentRun(runId, { canceled: true, reason: 'stop_requested_while_waiting' }),
      disposition: 'canceled'
    };
  }
  if (state === 'stopping') {
    return { run: toAgentRunDto(record.run), disposition: 'stopping' };
  }
  return { run: markAgentRunStopping(runId), disposition: 'stopping' };
}

export function setAgentRunAcceptedResult(runId: string, result: unknown = null): AgentRunDto {
  const record = requireRecord(runId);
  if (isTerminalStatus(record.run.status)) return toAgentRunDto(record.run);
  if (!isActiveStatus(record.run.status)) {
    throw transitionError(record, 'accepted-result', [...ACTIVE_STATUSES]);
  }
  record.run.result = normalizeJson(result, 'result');
  record.run.updatedAt = new Date().toISOString();
  scheduleAgentRunPersistence();
  return toAgentRunDto(record.run);
}

export function completeAgentRun(runId: string, result: unknown = null): AgentRunDto {
  return transition(runId, 'succeeded', ['accepted', 'waiting', 'running'], {
    result: normalizeJson(result, 'result'),
    error: null
  });
}

export function failAgentRun(runId: string, error: unknown = null): AgentRunDto {
  return transition(runId, 'failed', ['accepted', 'waiting', 'running', 'stopping'], {
    result: null,
    error: normalizeFailure(error)
  });
}

export function stopAgentRun(runId: string, result: unknown = null): AgentRunDto {
  return transition(runId, 'stopped', ['accepted', 'waiting', 'running', 'stopping'], {
    result: normalizeJson(result, 'result'),
    error: null
  });
}

/**
 * 关闭流程在截止时间内没有等到执行器结算时，把剩余活动 run 记为中断。
 * 与重启恢复使用同一终态语义：只记录身份与未知结果，不证明设备已释放，也不会
 * 自动续跑；`recovery.source` 记录实际关闭原因（例如 `server_shutdown`）。
 * 已进入终态的 run 原样返回，不覆盖执行器的实际结果。
 */
export function interruptAgentRun(
  runId: string,
  { reason = 'server_shutdown', message }: { reason?: string; message?: string } = {}
): AgentRunDto {
  const record = requireRecord(runId);
  if (isTerminalStatus(record.run.status)) return toAgentRunDto(record.run);
  const previousState = record.run.status;
  return transition(runId, 'interrupted', ['accepted', 'waiting', 'running', 'stopping'], {
    result: null,
    error: {
      code: 'AGENT_RUN_INTERRUPTED',
      message: message || '服务关闭时该执行尚未结束，已标记为中断且不会自动续跑',
      statusCode: 503,
      details: { reason, previousState },
      retryable: false
    }
  });
}

export function releaseAgentRunIdempotency(runId: string): AgentRunDto {
  const record = requireRecord(runId);
  if (!record.run.idempotencyKey) return toAgentRunDto(record.run);
  const indexKey = idempotencyIndexKey(record.run.operationId, record.run.idempotencyKey);
  if (idempotencyIndex.get(indexKey)?.runId === runId) idempotencyIndex.delete(indexKey);
  record.run.idempotencyKey = null;
  scheduleAgentRunPersistence();
  return toAgentRunDto(record.run);
}

export function discardAgentRun(runId: string): AgentRunDto {
  const record = requireRecord(runId);
  const allowedStatuses: AgentRunStatus[] = ['accepted', 'running'];
  if (!allowedStatuses.includes(record.run.status)) {
    throw transitionError(record, 'discarded', allowedStatuses);
  }

  const discarded = toAgentRunDto(record.run);
  removeRecord(runId);
  scheduleAgentRunPersistence();
  return discarded;
}

export function getAgentRun(runId: string): AgentRunDto | null {
  assertAgentRunStoreReadable();
  if (pruneTerminalRuns() > 0) scheduleAgentRunPersistence();
  return toAgentRunDto(runs.get(runId)?.run);
}

export function listAgentRuns({
  operationId = null,
  state = null,
  status = null,
  limit = 500
}: ListAgentRunsQuery = {}): AgentRunDto[] {
  assertAgentRunStoreReadable();
  if (pruneTerminalRuns() > 0) scheduleAgentRunPersistence();
  const normalizedLimit = Math.min(Math.max(Number(limit) || 0, 0), 500);
  if (normalizedLimit === 0) return [];
  const requestedState = state || status;

  return [...runs.values()]
    .filter(record => !operationId || record.run.operationId === operationId)
    .filter(record => !requestedState || record.run.status === requestedState)
    .sort((left, right) => right.sequence - left.sequence)
    .slice(0, normalizedLimit)
    .map(record => toAgentRunDto(record.run));
}

export function getCurrentAgentRun(): AgentRunDto | null {
  return getActiveAgentRuns()[0] || null;
}

export function getActiveAgentRuns(): AgentRunDto[] {
  assertAgentRunStoreReadable();
  if (pruneTerminalRuns() > 0) scheduleAgentRunPersistence();
  return [...runs.values()]
    .filter(record => isActiveStatus(record.run.status))
    .sort(compareActiveRuns)
    .map(record => toAgentRunDto(record.run));
}

export function getLatestTerminalAgentRun(): AgentRunDto | null {
  assertAgentRunStoreReadable();
  if (pruneTerminalRuns() > 0) scheduleAgentRunPersistence();
  const record = [...runs.values()]
    .filter(item => isTerminalStatus(item.run.status))
    .sort((left, right) =>
      terminalFinishedAt(right) - terminalFinishedAt(left)
      || (right.terminalSequence ?? 0) - (left.terminalSequence ?? 0)
    )[0];
  return toAgentRunDto(record?.run);
}

function resetAgentRunState({ clearMemory = true }: { clearMemory?: boolean } = {}): void {
  persistenceGeneration += 1;
  persistence = {
    enabled: false,
    required: false,
    filePath: DEFAULT_AGENT_RUN_STORE_PATH,
    readStore: readJsonFile,
    writeStore: writeJsonFile,
    runtimeLogger: logger
  };
  persistenceDirty = false;
  persistenceError = null;
  persistenceStartQueued = false;
  if (clearMemory) {
    runs.clear();
    idempotencyIndex.clear();
    sequence = 0;
    terminalSequence = 0;
  }
}

export function resetAgentRunsForTests(): void {
  resetAgentRunState();
}
