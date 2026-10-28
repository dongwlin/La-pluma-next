import { getActiveAgentRuns, getLatestTerminalAgentRun } from './agentRunService.ts';
import { getCopilotSetRunProgress } from './copilotSetRunService.js';
import { getMaaExecutionLeaseSnapshot } from './executionCoordinatorService.ts';
import { getRealtimeLogs, getTaskStatus } from './maaProcessService.ts';
import { getScheduleExecutionStatus } from './schedulerService.js';
import { resolveBoundedInteger } from '../utils/numericQueryHelper.ts';

const ACTIVE_RUN_STATES = new Set(['accepted', 'waiting', 'running', 'stopping']);
const DEVICE_OWNING_RUN_STATES = new Set(['running', 'stopping']);

function normalizeLineCount(lines) {
  return resolveBoundedInteger(lines, { defaultValue: 80, min: 1, max: 500 });
}

/**
 * Adds the process projection to an active run. Progress is read from the
 * current task/schedule, so it only describes the run that owns execution.
 * A daily flow that has not published its schedule state yet is reported as
 * waiting instead of borrowing another flow's steps.
 */
export function enrichAgentRun(run) {
  if (!run || !ACTIVE_RUN_STATES.has(run.state)) return run;

  const schedule = getScheduleExecutionStatus();
  const task = getTaskStatus();
  if (run.operationId === 'run_daily_flow') {
    if (schedule.runId !== run.runId) {
      return {
        ...run,
        progress: {
          currentStep: null,
          totalSteps: null,
          currentTask: null,
          message: run.state === 'accepted' ? '等待执行权' : '等待流程状态'
        }
      };
    }
    return {
      ...run,
      progress: {
        scheduleId: schedule.scheduleId,
        currentStep: schedule.currentStep,
        totalSteps: schedule.totalSteps,
        currentTask: schedule.currentTask,
        shouldStop: schedule.shouldStop,
        message: schedule.message || (schedule.isRunning ? '今日流程执行中' : '今日流程正在收尾')
      }
    };
  }
  if (run.operationId === 'run_copilot_set') {
    const progress = getCopilotSetRunProgress(run.runId);
    if (progress) return { ...run, progress };
    return {
      ...run,
      progress: {
        currentStep: null,
        totalSteps: null,
        currentTask: null,
        message: run.state === 'waiting' ? '等待开始下一关' : '等待作业集状态'
      }
    };
  }
  return {
    ...run,
    progress: {
      currentStep: null,
      totalSteps: null,
      currentTask: task.taskName,
      message: task.stopRequested ? '正在终止任务' : task.isRunning ? '任务执行中' : '等待任务启动'
    }
  };
}

/**
 * Describes device ownership without guessing: `run` means a tracked run owns
 * execution, `external` means device activity is visible without such a run
 * (flows, jobs or another cooperating process), `pending` means only active
 * intents exist that do not own the device (accepted or waiting runs), `idle`
 * means nothing is visible, and `unknown` means the lease file exists but
 * cannot be verified.
 */
function describeOccupancy({ activeRuns, task, schedule, lease }) {
  const current = activeRuns[0] || null;
  const owningRun = activeRuns.find(run => DEVICE_OWNING_RUN_STATES.has(run.state)) || null;

  const sources = [];
  if (activeRuns.length) sources.push('run');
  if (task.isRunning) sources.push('task');
  if (schedule.isRunning) sources.push('schedule');
  if (lease.state === 'held') sources.push('lease');

  const deviceBusy = Boolean(task.isRunning || schedule.isRunning || lease.state === 'held');
  let state = 'idle';
  if (owningRun) state = 'run';
  else if (deviceBusy) state = 'external';
  else if (lease.state === 'unknown') state = 'unknown';
  else if (activeRuns.length) state = 'pending';

  return {
    state,
    runId: current?.runId || null,
    runState: current?.state || null,
    sources,
    lease,
    task: {
      isRunning: Boolean(task.isRunning),
      taskName: task.taskName ?? null,
      taskType: task.taskType ?? null,
      stopRequested: Boolean(task.stopRequested)
    },
    schedule: {
      isRunning: Boolean(schedule.isRunning),
      scheduleId: schedule.scheduleId ?? null,
      runId: schedule.runId ?? null,
      currentStep: schedule.currentStep ?? null,
      totalSteps: schedule.totalSteps ?? 0,
      currentTask: schedule.currentTask ?? null,
      shouldStop: Boolean(schedule.shouldStop)
    }
  };
}

/**
 * One observable snapshot for every client: the current active run, all other
 * active intents, the latest terminal run and the device occupancy projection.
 * Legacy task fields stay at the top level for old clients.
 */
export async function buildAgentRunSnapshot({ lines = 80 } = {}) {
  const task = getTaskStatus();
  const schedule = getScheduleExecutionStatus();
  const activeRuns = getActiveAgentRuns();
  const currentRunId = activeRuns[0]?.runId || null;
  // Global process/schedule projections only describe the current run; a
  // copilot-set session is owned by its own runId and stays observable even
  // when another run is current.
  const enrichedRuns = activeRuns.map(run =>
    run.runId === currentRunId || run.operationId === 'run_copilot_set'
      ? enrichAgentRun(run)
      : run
  );
  const lease = await getMaaExecutionLeaseSnapshot();

  return {
    ...task,
    schedule,
    recentLogs: getRealtimeLogs(normalizeLineCount(lines)),
    run: enrichedRuns[0] || null,
    activeRuns: enrichedRuns,
    lastRun: getLatestTerminalAgentRun(),
    occupancy: describeOccupancy({ activeRuns, task, schedule, lease })
  };
}
