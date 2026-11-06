import { execMaaCommand } from './maaExecutionService.ts';
import { withMaaExecutionLease } from './executionCoordinatorService.ts';
import { createFightExecutionAction } from './fightResultService.ts';
import type { MaaCommandOutput, MaaProcessLifecycle } from './maaProcessService.ts';
import type { MaaExecutionLeaseRequest } from './executionCoordinatorService.ts';
import type { FightExecutionAction } from './fightResultService.ts';

export interface FightStageEntry {
  stage: string;
  times: string;
}

export interface FightRequestOptions {
  medicine?: unknown;
  medicineExpireDays?: unknown;
  /** @deprecated 旧版按瓶数表达临期药；新调用方使用 medicineExpireDays。 */
  expiringMedicine?: unknown;
  stone?: unknown;
  series?: unknown;
}

export interface FightStagePlan extends FightStageEntry {
  args: string[];
}

export type FightStageStatus = 'success' | 'failed' | 'skipped' | 'stopped' | 'pending';

export interface FightStageOutcome extends FightStagePlan {
  status: FightStageStatus;
  message: string;
  stdout: string;
  stderr: string;
}

export interface FightExecutionResult {
  stopped: boolean;
  stages: FightStageOutcome[];
  stdout: string;
  stderr: string;
  command: string;
  message: string;
}

export type FightStageExecutor = (
  args: readonly string[],
  taskName: string,
  lifecycle: MaaProcessLifecycle
) => Promise<MaaCommandOutput>;

export interface FightExecutionPorts {
  executeStage?: FightStageExecutor;
  withExecutionLease?: <T>(request: MaaExecutionLeaseRequest, run: () => Promise<T>) => Promise<T>;
  sleep?: (delayMs: number) => Promise<void>;
}

export interface ExecuteFightStagesOptions {
  stages: readonly FightStageEntry[];
  options?: FightRequestOptions;
  taskName: string;
  lifecycle?: MaaProcessLifecycle;
  shouldStop?: () => boolean;
  betweenStageDelayMs?: number;
  ports?: FightExecutionPorts;
}

function readRecordField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function parseStageText(value: string): FightStageEntry {
  const separator = value.indexOf(':');
  if (separator <= 0) return { stage: value.trim(), times: '' };
  return {
    stage: value.slice(0, separator).trim(),
    times: value.slice(separator + 1).trim()
  };
}

function parseStageList(value: string): FightStageEntry[] {
  return value
    .split(',')
    .map(part => parseStageText(part))
    .filter(entry => entry.stage);
}

export function normalizeFightStages(
  stages: unknown,
  legacyStage: unknown = '',
  legacyTimes: unknown = ''
): FightStageEntry[] {
  const rawStages: unknown[] = Array.isArray(stages)
    ? stages
    : [{ stage: legacyStage ?? '', times: legacyTimes ?? '' }];
  const entries: FightStageEntry[] = [];

  for (const item of rawStages) {
    if (typeof item === 'string') {
      entries.push(...parseStageList(item));
      continue;
    }
    if (typeof item !== 'object' || item === null) continue;
    const parsedEntries = parseStageList(textOf(readRecordField(item, 'stage')));
    if (!parsedEntries.length) continue;
    const explicitTimes = textOf(readRecordField(item, 'times')).trim();
    for (const parsed of parsedEntries) {
      entries.push({
        stage: parsed.stage,
        times: parsedEntries.length === 1 && explicitTimes ? explicitTimes : parsed.times
      });
    }
  }

  return entries;
}

function appendOption(args: string[], flag: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  args.push(flag, String(value));
}

export function buildFightStageArgs(
  entry: FightStageEntry,
  options: FightRequestOptions = {}
): string[] {
  const args = [entry.stage];
  if (entry.times) args.push('--times', entry.times);
  appendOption(args, '-m', options.medicine);
  if (options.medicineExpireDays !== undefined && options.medicineExpireDays !== null && options.medicineExpireDays !== '') {
    appendOption(args, '--medicine-expire-days', options.medicineExpireDays);
  } else {
    appendOption(args, '--expiring-medicine', options.expiringMedicine);
  }
  appendOption(args, '--stone', options.stone);
  if (options.series !== undefined
    && options.series !== null
    && options.series !== ''
    && String(options.series) !== '1') {
    args.push(`--series=${String(options.series)}`);
  }
  return args;
}

export function buildFightStagePlans(
  stages: readonly FightStageEntry[],
  options: FightRequestOptions = {}
): FightStagePlan[] {
  return stages.map(entry => ({
    ...entry,
    args: buildFightStageArgs(entry, options)
  }));
}

function readErrorField(error: unknown, key: 'stdout' | 'stderr'): string {
  const value = readRecordField(error, key);
  return typeof value === 'string' ? value : '';
}

function readErrorOutput(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  return [readErrorField(error, 'stdout'), readErrorField(error, 'stderr'), message]
    .filter(Boolean)
    .join('\n');
}

function isStoppedError(error: unknown): boolean {
  return readRecordField(error, 'stopped') === true;
}

function stageAction(
  taskName: string,
  plan: FightStagePlan,
  outcome: { output?: string; error?: unknown }
): FightExecutionAction {
  return createFightExecutionAction(taskName, plan.stage, {
    summary: { stage: plan.stage, times: plan.times },
    output: outcome.output ?? '',
    error: outcome.error
  });
}

function stageFailureError(
  error: unknown,
  plan: FightStagePlan,
  index: number,
  outcomes: readonly FightStageOutcome[]
): Error {
  const message = error instanceof Error ? error.message : String(error || '');
  const failure = new Error(`${plan.stage} 作战失败：${message}`, {
    ...(error instanceof Error ? { cause: error } : {})
  });
  const code = readRecordField(error, 'code');
  const statusCode = readRecordField(error, 'statusCode');
  const retryable = readRecordField(error, 'retryable');
  const details = readRecordField(error, 'details');
  return Object.assign(failure, {
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    ...(typeof statusCode === 'number' ? { statusCode } : {}),
    ...(typeof retryable === 'boolean' ? { retryable } : {}),
    details: {
      ...(typeof details === 'object' && details !== null && !Array.isArray(details)
        ? details as Record<string, unknown>
        : {}),
      stage: plan.stage,
      stageIndex: index + 1,
      stages: outcomes.map(outcome => ({
        stage: outcome.stage,
        times: outcome.times,
        status: outcome.status,
        message: outcome.message
      }))
    }
  });
}

function appendRemaining(
  outcomes: FightStageOutcome[],
  plans: readonly FightStagePlan[],
  startIndex: number,
  message: string
): void {
  for (let index = startIndex; index < plans.length; index += 1) {
    outcomes.push({
      ...plans[index],
      status: 'pending',
      message,
      stdout: '',
      stderr: ''
    });
  }
}

async function waitForNextStage(
  delayMs: number,
  shouldStop: () => boolean,
  sleep: (delayMs: number) => Promise<void>
): Promise<boolean> {
  if (delayMs <= 0) return !shouldStop();
  const deadline = Date.now() + delayMs;
  while (!shouldStop()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return true;
    await sleep(Math.min(remaining, 100));
  }
  return false;
}

export async function executeFightStages({
  stages,
  options = {},
  taskName,
  lifecycle = {},
  shouldStop = () => false,
  betweenStageDelayMs = 2000,
  ports = {}
}: ExecuteFightStagesOptions): Promise<FightExecutionResult> {
  const plans = buildFightStagePlans(stages, options);
  if (!plans.length) {
    throw new Error('至少需要一个有效关卡');
  }
  const executeStage: FightStageExecutor = ports.executeStage
    ?? ((args, stageTaskName, stageLifecycle) =>
      execMaaCommand('fight', args, stageTaskName, 'agent', true, false, stageLifecycle));
  const withExecutionLease = ports.withExecutionLease ?? withMaaExecutionLease;
  const sleep = ports.sleep ?? ((delayMs: number) =>
    new Promise<void>(resolve => { setTimeout(resolve, delayMs); }));

  return withExecutionLease({ source: 'agent', taskName, command: 'fight' }, async () => {
    const outcomes: FightStageOutcome[] = [];
    let sanityDepleted = false;
    let stopped = false;
    let command = 'fight';

    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index];
      if (stopped || shouldStop()) {
        stopped = true;
        appendRemaining(outcomes, plans, index, '任务已停止，未执行该关卡');
        break;
      }
      if (sanityDepleted) {
        outcomes.push({
          ...plan,
          status: 'skipped',
          message: '理智已耗尽，跳过该关卡',
          stdout: '',
          stderr: ''
        });
        continue;
      }

      const stageTaskName = plans.length > 1 ? `${taskName} (${plan.stage})` : taskName;
      let output: MaaCommandOutput | null = null;
      let stageError: unknown = null;
      try {
        output = await executeStage(plan.args, stageTaskName, lifecycle);
      } catch (error) {
        stageError = error;
      }

      if (stageError && (shouldStop() || isStoppedError(stageError))) {
        outcomes.push({
          ...plan,
          status: 'stopped',
          message: '任务已停止',
          stdout: readErrorField(stageError, 'stdout'),
          stderr: readErrorField(stageError, 'stderr')
        });
        stopped = true;
        appendRemaining(outcomes, plans, index + 1, '任务已停止，未执行该关卡');
        break;
      }

      const action = stageError
        ? stageAction(stageTaskName, plan, { output: readErrorOutput(stageError), error: stageError })
        : stageAction(stageTaskName, plan, { output: output?.stdout ?? '' });
      if (output) command = output.command || command;
      else command = textOf(readRecordField(stageError, 'command')) || command;
      outcomes.push({
        ...plan,
        status: action.status,
        message: action.message,
        stdout: output?.stdout ?? readErrorField(stageError, 'stdout'),
        stderr: output?.stderr ?? readErrorField(stageError, 'stderr')
      });
      if (action.sanityDepleted) sanityDepleted = true;
      if (action.status === 'failed') {
        appendRemaining(outcomes, plans, index + 1, '前一关失败，未执行该关卡');
        throw stageFailureError(stageError ?? new Error(action.message), plan, index, outcomes);
      }

      if (index < plans.length - 1) {
        const continueNext = await waitForNextStage(betweenStageDelayMs, shouldStop, sleep);
        if (!continueNext) {
          stopped = true;
          appendRemaining(outcomes, plans, index + 1, '任务已停止，未执行该关卡');
          break;
        }
      }
    }

    if (!stopped && shouldStop()) stopped = true;
    const stdout = outcomes.map(outcome => outcome.stdout).filter(Boolean).join('\n');
    const stderr = outcomes.map(outcome => outcome.stderr).filter(Boolean).join('\n');
    const message = stopped
      ? '理智作战已停止'
      : outcomes.length > 0
        ? `理智作战完成：${outcomes.map(outcome => outcome.message).join('；')}`
        : '理智作战未执行任何关卡';

    return { stopped, stages: outcomes, stdout, stderr, command, message };
  });
}
