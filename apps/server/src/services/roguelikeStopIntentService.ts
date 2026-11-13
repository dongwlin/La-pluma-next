import { getAgentRun, getAgentRunInput, getCurrentAgentRun, requestAgentRunStop } from './agentRunService.ts';
import type { AgentRunDto } from './agentRunService.ts';
import { parseMaaCallbackEvents } from './maaCallbackService.ts';
import { createMaaLogCheckpoint, readMaaLogIncrement } from './maaLogFileService.ts';
import type { MaaLogCheckpoint, MaaLogIncrement } from './maaLogFileService.ts';
import { getTaskStatus, stopCurrentTask } from './maaProcessService.ts';
import { getRoguelikeTaskchain, isRoguelikeCommand } from './roguelikeResultService.ts';
import { createLogger } from '../utils/logger.ts';

export const ROGUELIKE_STOP_INTENT_MAX_WAIT_MS = 600_000;

const POLL_INTERVAL_MS = 1_000;
const LOG_LINE_TIME_PATTERN = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/;
const COMBAT_START_MARKER = 'StageInfo';
const COMBAT_END_MARKER = 'RoguelikeCombatEnd';

const logger = createLogger('RoguelikeStopIntent');

export interface RoguelikeStopIntent {
  mode: 'after-combat';
  requestedAt: string;
  deadline: string;
  combat: boolean | null;
}

export type RoguelikeStopIntentOutcome =
  | { status: 'deferred'; intent: RoguelikeStopIntent }
  | { status: 'already-pending'; intent: RoguelikeStopIntent }
  | { status: 'immediate' };

export interface RoguelikeStopIntentTimer {
  cancel(): void;
}

export interface RoguelikeStopIntentScheduler {
  now(): number;
  schedule(callback: () => void, delayMs: number): RoguelikeStopIntentTimer;
}

export interface RoguelikeStopIntentRuntime {
  scheduler: RoguelikeStopIntentScheduler;
  maxWaitMs: number;
  pollIntervalMs: number;
  createCheckpoint(): Promise<MaaLogCheckpoint | null>;
  readLogIncrement(checkpoint: MaaLogCheckpoint): Promise<MaaLogIncrement>;
  readLogTail(checkpoint: MaaLogCheckpoint): Promise<MaaLogIncrement>;
  getRun(runId: string): AgentRunDto | null;
  getRunInput(runId: string): unknown;
  getCurrentRun(): AgentRunDto | null;
  isDeviceTaskRunning(): boolean;
  stopDeviceTask(): unknown;
  requestRunStop(runId: string): unknown;
}

interface StopIntentRegistration {
  intent: RoguelikeStopIntent;
  taskchain: string;
  startedAtMs: number;
  checkpoint: MaaLogCheckpoint;
  deadlineMs: number;
  polling: boolean;
  timer: RoguelikeStopIntentTimer | null;
}

interface CombatSignal {
  combat: boolean | null;
  combatEnded: boolean;
}

const defaultScheduler: RoguelikeStopIntentScheduler = {
  now: () => Date.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  }
};

const defaultRuntime: RoguelikeStopIntentRuntime = {
  scheduler: defaultScheduler,
  maxWaitMs: ROGUELIKE_STOP_INTENT_MAX_WAIT_MS,
  pollIntervalMs: POLL_INTERVAL_MS,
  createCheckpoint: () => createMaaLogCheckpoint(),
  readLogIncrement: checkpoint => readMaaLogIncrement(checkpoint),
  readLogTail: checkpoint => readMaaLogIncrement({ logPath: checkpoint.logPath, size: 0 }),
  getRun: runId => getAgentRun(runId),
  getRunInput: runId => getAgentRunInput(runId),
  getCurrentRun: () => getCurrentAgentRun(),
  isDeviceTaskRunning: () => Boolean(getTaskStatus().isRunning),
  stopDeviceTask: () => stopCurrentTask(),
  requestRunStop: runId => requestAgentRunStop(runId)
};

let runtime: RoguelikeStopIntentRuntime = defaultRuntime;
const intents = new Map<string, StopIntentRegistration>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLineTimeMs(line: string): number | null {
  const match = LOG_LINE_TIME_PATTERN.exec(line);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millisecond] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millisecond)
  ).getTime();
}

function filterLogSince(logText: string, sinceMs: number): string {
  return logText
    .split('\n')
    .filter(line => {
      const lineTimeMs = readLineTimeMs(line);
      return lineTimeMs !== null && lineTimeMs >= sinceMs;
    })
    .join('\n');
}

function readCombatSignal(logText: string, taskchain: string, sinceMs: number): CombatSignal {
  let combat: boolean | null = null;
  let combatEnded = false;

  for (const event of parseMaaCallbackEvents(filterLogSince(logText, sinceMs), taskchain)) {
    if (event.callback !== 'SubTaskExtraInfo') continue;
    const what = event.what;
    if (what === COMBAT_START_MARKER) {
      combat = true;
      combatEnded = false;
    } else if (what === COMBAT_END_MARKER) {
      combat = false;
      combatEnded = true;
    }
  }

  return { combat, combatEnded };
}

function resolveTaskchain(input: unknown): string | null {
  if (!isRecord(input)) return null;

  const taskConfig = input.taskConfig;
  if (isRecord(taskConfig)) {
    if (taskConfig.type === 'Roguelike') return getRoguelikeTaskchain('roguelike');
    if (taskConfig.type === 'Reclamation') return getRoguelikeTaskchain('reclamation');
    return null;
  }
  if (Array.isArray(input.taskConfigs) && input.taskConfigs.length > 0) return null;

  const command = input.command;
  if (isRoguelikeCommand(command)) return getRoguelikeTaskchain(command);

  const taskType = input.taskType;
  if (taskType === 'Roguelike') return getRoguelikeTaskchain('roguelike');
  if (taskType === 'Reclamation') return getRoguelikeTaskchain('reclamation');
  return null;
}

function findRegistration(runId: string): StopIntentRegistration | null {
  return intents.get(runId) ?? null;
}

function isWaitingRun(runId: string): boolean {
  const run = runtime.getRun(runId);
  if (!run || run.state !== 'running') return false;
  const current = runtime.getCurrentRun();
  if (!current || current.runId !== runId) return false;
  return runtime.isDeviceTaskRunning();
}

function release(runId: string): boolean {
  const registration = findRegistration(runId);
  if (!registration) return false;
  intents.delete(runId);
  registration.timer?.cancel();
  registration.timer = null;
  return true;
}

function schedulePoll(runId: string, registration: StopIntentRegistration): void {
  if (intents.get(runId) !== registration) return;
  registration.timer = runtime.scheduler.schedule(() => {
    registration.timer = null;
    void pollStopIntent(runId, registration);
  }, Math.max(0, runtime.pollIntervalMs));
}

function dispatchStop(runId: string): void {
  try {
    const result = runtime.stopDeviceTask();
    if (isRecord(result) && result.success === false) {
      logger.warn('停止等待战斗结束的任务未成功', {
        runId,
        message: typeof result.message === 'string' ? result.message : null
      });
    }
  } catch (error) {
    logger.warn('停止等待战斗结束的任务失败', { runId, error: describeError(error) });
  }
  try {
    runtime.requestRunStop(runId);
  } catch (error) {
    logger.warn('记录等待战斗结束后的停止状态失败', { runId, error: describeError(error) });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pollStopIntent(runId: string, registration: StopIntentRegistration): Promise<void> {
  if (registration.polling || intents.get(runId) !== registration) return;
  registration.polling = true;

  let dispatch = false;
  try {
    if (!isWaitingRun(runId)) {
      release(runId);
      return;
    }

    let increment: MaaLogIncrement | null = null;
    try {
      increment = await runtime.readLogIncrement(registration.checkpoint);
    } catch {
      increment = null;
    }

    if (intents.get(runId) !== registration) return;
    if (!isWaitingRun(runId)) {
      release(runId);
      return;
    }

    const incrementText = increment !== null
      && (increment.status === 'ok' || increment.status === 'truncated')
      ? increment.text
      : '';
    const combatEnded = incrementText !== ''
      && readCombatSignal(incrementText, registration.taskchain, registration.startedAtMs).combatEnded;
    if (combatEnded || runtime.scheduler.now() >= registration.deadlineMs) dispatch = true;
  } catch (error) {
    logger.warn('轮询战斗结束状态失败，按立即停止处理', { runId, error: describeError(error) });
    if (release(runId)) dispatchStop(runId);
    return;
  } finally {
    registration.polling = false;
  }

  if (intents.get(runId) !== registration) return;
  if (!dispatch) {
    schedulePoll(runId, registration);
    return;
  }

  release(runId);
  dispatchStop(runId);
}

export function getRoguelikeStopIntent(runId: string): RoguelikeStopIntent | null {
  return findRegistration(runId)?.intent ?? null;
}

export function cancelRoguelikeStopIntent(runId: string): boolean {
  return release(runId);
}

export function releaseAllRoguelikeStopIntents(): void {
  for (const runId of [...intents.keys()]) release(runId);
}

export async function beginRoguelikeStopIntent(runId: string): Promise<RoguelikeStopIntentOutcome> {
  const existing = findRegistration(runId);
  if (existing) {
    if (isWaitingRun(runId)) return { status: 'already-pending', intent: existing.intent };
    release(runId);
  }

  const run = runtime.getRun(runId);
  if (!run || run.state !== 'running' || run.operationId !== 'run_task') return { status: 'immediate' };

  const current = runtime.getCurrentRun();
  if (!current || current.runId !== runId) return { status: 'immediate' };

  const taskchain = resolveTaskchain(runtime.getRunInput(runId));
  if (!taskchain) return { status: 'immediate' };
  if (!runtime.isDeviceTaskRunning()) return { status: 'immediate' };

  const startedAtMs = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  if (!Number.isFinite(startedAtMs)) return { status: 'immediate' };

  const checkpoint = await runtime.createCheckpoint();
  if (!checkpoint) return { status: 'immediate' };

  let recentLog: MaaLogIncrement;
  try {
    recentLog = await runtime.readLogTail(checkpoint);
  } catch {
    return { status: 'immediate' };
  }
  if (readCombatSignal(recentLog.text, taskchain, startedAtMs).combat !== true) return { status: 'immediate' };

  const latestRun = runtime.getRun(runId);
  const latestCurrent = runtime.getCurrentRun();
  if (!latestRun || latestRun.state !== 'running' || !latestCurrent || latestCurrent.runId !== runId) {
    return { status: 'immediate' };
  }

  const requestedAtMs = runtime.scheduler.now();
  const deadlineMs = requestedAtMs + runtime.maxWaitMs;
  const registration: StopIntentRegistration = {
    intent: {
      mode: 'after-combat',
      requestedAt: new Date(requestedAtMs).toISOString(),
      deadline: new Date(deadlineMs).toISOString(),
      combat: true
    },
    taskchain,
    startedAtMs,
    checkpoint,
    deadlineMs,
    polling: false,
    timer: null
  };

  intents.set(runId, registration);
  schedulePoll(runId, registration);
  return { status: 'deferred', intent: registration.intent };
}

export function configureRoguelikeStopIntentRuntimeForTests(
  overrides: Partial<RoguelikeStopIntentRuntime> = {}
): void {
  runtime = { ...defaultRuntime, ...overrides };
}

export function resetRoguelikeStopIntentForTests(): void {
  releaseAllRoguelikeStopIntents();
  runtime = defaultRuntime;
}
