import express from 'express';
import { execMaaCommand, execDynamicTask } from '../services/maaExecutionService.js';
import { stopCurrentTask } from '../services/maaProcessService.js';
import { executeScheduleNow, getScheduledTaskFlowPlan, stopScheduleExecution } from '../services/schedulerService.js';
import { loadUserConfig } from '../services/configStorageService.ts';
import { runCurrentActivityCopilots } from '../services/activityCopilotRunService.js';
import {
  createDailyFlowExecutionError,
  executeAgentTask,
  normalizeCopilotSetExecutionRequest,
  normalizeDailyFlowRequest
} from '../services/agentActionService.js';
import {
  continueManualCopilotSet,
  hasCopilotSetSession,
  requestCopilotSetRunStop,
  runContinuousCopilotSet,
  startManualCopilotSet
} from '../services/copilotSetRunService.js';
import {
  beginAgentRun,
  startAgentRunForExecution,
  completeAgentRun,
  failAgentRun,
  stopAgentRun,
  requestAgentRunStop,
  getAgentRun,
  getCurrentAgentRun,
  releaseAgentRunIdempotency,
  setAgentRunAcceptedResult,
  flushAgentRunStore,
  withFlushedAgentRunSnapshot
} from '../services/agentRunService.js';
import { enrichAgentRun } from '../services/runSnapshotService.js';
import {
  asyncHandler,
  agentError,
  sendSuccess,
  sendDryRun,
  sendError
} from '../utils/apiHelper.ts';
import { createLogger } from '../utils/logger.ts'
import { withExecutionLogContext } from '../utils/logContext.ts'
import { resolveRequestConnection } from './requestConnection.js'

/**
 * 执行路由与 Run 生命周期适配：任务、流程、作业集的 tracked 执行，目标停止与
 * 202/幂等响应集中在本 router。agent.js 只按原注册顺序挂载；Run 与设备租约
 * 仍由 agentRunService / executionCoordinatorService 唯一持有。
 */
const router = express.Router();
const logger = createLogger('AgentRoutes');

const ACTIVE_RUN_STATES = new Set(['accepted', 'waiting', 'running', 'stopping']);
const TERMINAL_RUN_STATES = new Set(['succeeded', 'failed', 'stopped', 'interrupted']);

function getIdempotencyKey(req) {
  return req.get?.('Idempotency-Key')
    ?? req.headers?.['idempotency-key']
    ?? req.headers?.['Idempotency-Key']
    ?? null;
}

function setRunResponseHeaders(res, run, replayed, includeLocation = false) {
  const headers = {
    'X-La-Pluma-Run-Id': run.runId,
    'Idempotency-Replayed': String(Boolean(replayed))
  };
  if (includeLocation) headers.Location = run.links.self;

  for (const [name, value] of Object.entries(headers)) {
    if (typeof res.set === 'function') res.set(name, value);
    else if (typeof res.setHeader === 'function') res.setHeader(name, value);
  }
}

function runResponseData(result, run) {
  const base = result && typeof result === 'object' && !Array.isArray(result)
    ? { ...result }
    : { result };
  return {
    ...base,
    runId: run.runId,
    state: run.state,
    pollUrl: run.links.self,
    stopUrl: run.links.stop,
    run
  };
}

function sendRunSuccess(res, req, result, run, {
  message = '操作成功',
  replayed = false,
  accepted = false
} = {}) {
  const enrichedRun = enrichAgentRun(run);
  setRunResponseHeaders(res, enrichedRun, replayed, accepted);
  if (accepted) res.status(202);
  return sendSuccess(
    res,
    req,
    runResponseData(result, enrichedRun),
    message,
    { runId: enrichedRun.runId, idempotentReplay: replayed }
  );
}

function sendRunFailure(res, req, run, replayed = false) {
  const error = agentError(run.error?.code || 'AGENT_RUN_FAILED', run.error?.message || 'Agent run 执行失败', {
    statusCode: run.error?.statusCode || 500,
    details: {
      ...(run.error?.details || {}),
      runId: run.runId,
      run
    },
    retryable: run.error?.retryable ?? false
  });
  setRunResponseHeaders(res, run, replayed);
  return sendError(res, req, error, undefined, { runId: run.runId, idempotentReplay: replayed });
}

function respondWithExistingRun(res, req, run, message = '返回已有执行') {
  if (run.state === 'failed' || run.state === 'interrupted') {
    return sendRunFailure(res, req, run, true);
  }
  const accepted = ACTIVE_RUN_STATES.has(run.state);
  return sendRunSuccess(res, req, run.result, run, {
    message,
    replayed: true,
    accepted
  });
}

function isPreExecutionError(error) {
  const code = error?.code || '';
  return code === 'MAA_EXECUTION_BUSY'
    || code === 'AGENT_EXECUTION_BUSY'
    || code === 'AGENT_SCHEDULE_ALREADY_RUNNING'
    || code === 'AGENT_DAILY_FLOW_REJECTED'
    || code === 'AGENT_COPILOT_SET_UNAVAILABLE'
    || code === 'AGENT_COPILOT_SET_REJECTED'
    || code.startsWith('AGENT_VALIDATION_');
}

// Shutdown rejections are not failures of the execution itself: the run had not
// started when the service began draining. Settling it as `stopped` matches the
// pre-start gate, so callers never see a shutdown as a successful execution.
function isShutdownRejection(error) {
  const code = error?.code || '';
  return code === 'MAA_EXECUTION_SHUTTING_DOWN' || code === 'AGENT_EXECUTION_SHUTTING_DOWN';
}

function resolveResponseMessage(message, result, fallback) {
  const resolved = typeof message === 'function' ? message(result) : message;
  return resolved || fallback;
}

async function settleBackgroundRun(runId, outcome) {
  const current = getAgentRun(runId);
  if (!current || TERMINAL_RUN_STATES.has(current.state)) return current;
  try {
    let run;
    if (outcome?.stopped || current.state === 'stopping') {
      run = stopAgentRun(runId, outcome?.result || null);
    } else if (outcome?.ok) {
      run = completeAgentRun(runId, outcome.result);
    } else {
      run = failAgentRun(runId, outcome?.error || new Error('后台任务执行失败'));
    }
    await flushAgentRunStore();
    return run;
  } catch (error) {
    logger.error('更新或持久化 Agent run 终态失败', { runId, error: error.message });
    return getAgentRun(runId);
  }
}

async function persistAgentRunMutation(runId, context) {
  try {
    await flushAgentRunStore();
    return null;
  } catch (error) {
    logger.error(context, { runId, error: error.message });
    return error;
  }
}

async function respondWithPersistedAgentRun(res, req, runId, context, respond) {
  try {
    return await withFlushedAgentRunSnapshot(runId, respond);
  } catch (error) {
    logger.error(context, { runId, error: error.message });
    return sendRunPersistenceFailure(res, req, runId, error);
  }
}

function sendRunPersistenceFailure(res, req, runId, error) {
  const run = getAgentRun(runId);
  const persistenceError = agentError(
    error?.code || 'AGENT_RUN_PERSISTENCE_FAILED',
    error?.message || 'Agent run 持久化失败',
    {
      statusCode: error?.statusCode || error?.status || 503,
      details: {
        ...(error?.details || {}),
        runId,
        run
      },
      retryable: error?.retryable ?? true
    }
  );
  return sendError(res, req, persistenceError, undefined, { runId });
}

function mergeBackgroundOutcome(outcome, acceptedResult) {
  const accepted = acceptedResult && typeof acceptedResult === 'object' && !Array.isArray(acceptedResult)
    ? acceptedResult
    : { acceptedResult };
  const terminal = outcome?.result && typeof outcome.result === 'object' && !Array.isArray(outcome.result)
    ? outcome.result
    : { result: outcome?.result ?? null };
  return {
    ...outcome,
    result: { ...accepted, ...terminal }
  };
}

export async function executeTrackedAgentAction(req, res, {
  operationId,
  input,
  waitForCompletion = true,
  metadata = {},
  execute,
  successMessage = '操作成功',
  acceptedMessage = '任务已接受',
  stoppedMessage = '任务已终止',
  settleOnReturn = true
}) {
  const reservation = beginAgentRun({
    operationId,
    idempotencyKey: getIdempotencyKey(req),
    input,
    metadata
  });
  if (reservation.replayed) {
    return respondWithPersistedAgentRun(
      res,
      req,
      reservation.run.runId,
      'Agent run 重放响应前持久化失败',
      run => respondWithExistingRun(res, req, run || reservation.run)
    );
  }

  const runId = reservation.run.runId;
  // 执行上下文跟随 Run 本身：请求返回后的子进程输出与后台收尾仍记录同一个
  // runId/operationId，不能把 HTTP 请求结束当作执行完成。
  const executionLogContext = { runId, operationId };
  const admissionPersistenceError = await persistAgentRunMutation(
    runId,
    'Agent run 接受状态持久化失败，已阻止执行'
  );
  if (admissionPersistenceError) {
    const rejectedRun = failAgentRun(runId, admissionPersistenceError);
    releaseAgentRunIdempotency(runId);
    await persistAgentRunMutation(runId, 'Agent run 持久化失败终态写入失败');
    return sendRunFailure(res, req, rejectedRun);
  }

  const ensureRunStarted = () => startAgentRunForExecution(runId);
  const observeProcessStart = () => {
    const run = getAgentRun(runId);
    if (!run) return null;
    if (run.state === 'accepted') return ensureRunStarted();
    if (run.state === 'stopping' || TERMINAL_RUN_STATES.has(run.state)) {
      // A stop landed between the pre-start gate and the spawn: kill what just started.
      try {
        stopCurrentTask();
        stopScheduleExecution();
      } catch (error) {
        logger.error('停止已取消的执行进程失败', { runId, error: error.message });
      }
    }
    return run;
  };
  let acceptedResult;
  let hasAcceptedResult = false;
  let pendingOutcome = null;
  const settleAcceptedBackgroundRun = async (outcome) => {
    if (!hasAcceptedResult) {
      pendingOutcome = outcome;
      return null;
    }
    return settleBackgroundRun(runId, mergeBackgroundOutcome(outcome, acceptedResult));
  };
  const lifecycle = {
    onBeforeStart: ensureRunStarted,
    onStarted: observeProcessStart,
    ...(!waitForCompletion
      ? {
          onSettled: outcome => withExecutionLogContext(
            executionLogContext,
            () => settleAcceptedBackgroundRun(outcome)
          )
        }
      : {})
  };

  try {
    const result = await withExecutionLogContext(
      executionLogContext,
      () => execute(lifecycle, { runId })
    );
    acceptedResult = result;
    hasAcceptedResult = true;
    if (pendingOutcome) {
      const outcome = pendingOutcome;
      pendingOutcome = null;
      await withExecutionLogContext(
        executionLogContext,
        () => settleAcceptedBackgroundRun(outcome)
      );
    }
    let run = getAgentRun(runId);
    if (!waitForCompletion && ACTIVE_RUN_STATES.has(run.state)) {
      run = setAgentRunAcceptedResult(runId, result);
    }
    if (waitForCompletion && !TERMINAL_RUN_STATES.has(run.state) && settleOnReturn) {
      run = run.state === 'stopping' || result?.stopped
        ? stopAgentRun(runId, result)
        : completeAgentRun(runId, result);
    }
    return respondWithPersistedAgentRun(
      res,
      req,
      runId,
      'Agent run 响应状态持久化失败',
      persistedRun => {
        run = persistedRun || run;
        if (run.state === 'failed' || run.state === 'interrupted') {
          return sendRunFailure(res, req, run);
        }
        if (run.state === 'stopped') {
          return sendRunSuccess(res, req, run.result, run, {
            message: resolveResponseMessage(stoppedMessage, run.result, '任务已终止')
          });
        }
        const accepted = !waitForCompletion && ACTIVE_RUN_STATES.has(run.state);
        return sendRunSuccess(res, req, TERMINAL_RUN_STATES.has(run.state) ? run.result : result, run, {
          message: accepted
            ? acceptedMessage
            : resolveResponseMessage(successMessage, result, '操作成功'),
          accepted
        });
      }
    );
  } catch (error) {
    const current = getAgentRun(runId);
    if (current && TERMINAL_RUN_STATES.has(current.state)) {
      return respondWithPersistedAgentRun(
        res,
        req,
        runId,
        'Agent run 终态响应持久化失败',
        persistedRun => {
          const terminalRun = persistedRun || current;
          if (terminalRun.state === 'stopped') {
            return sendRunSuccess(res, req, terminalRun.result, terminalRun, {
              message: resolveResponseMessage(stoppedMessage, terminalRun.result, '任务已终止')
            });
          }
          return sendRunFailure(res, req, terminalRun);
        }
      );
    }
    if (isPreExecutionError(error) && current && !TERMINAL_RUN_STATES.has(current.state)) {
      const rejectedRun = failAgentRun(runId, error);
      releaseAgentRunIdempotency(runId);
      const persistenceError = await persistAgentRunMutation(runId, 'Agent run 拒绝状态持久化失败');
      if (persistenceError) return sendRunPersistenceFailure(res, req, runId, persistenceError);
      return sendRunFailure(res, req, rejectedRun);
    }
    const run = error?.stopped || isShutdownRejection(error) || current?.state === 'stopping'
      ? stopAgentRun(runId, {
          message: error.message,
          exitCode: error.exitCode ?? null,
          signal: error.signal ?? null,
          ...(isShutdownRejection(error) ? { reason: 'server_shutdown' } : {})
        })
      : failAgentRun(runId, error);
    return respondWithPersistedAgentRun(
      res,
      req,
      runId,
      'Agent run 终态持久化失败',
      persistedRun => {
        const terminalRun = persistedRun || run;
        if (terminalRun.state === 'stopped') {
          return sendRunSuccess(res, req, terminalRun.result, terminalRun, {
            message: resolveResponseMessage(stoppedMessage, terminalRun.result, '任务已终止')
          });
        }
        return sendRunFailure(res, req, terminalRun);
      }
    );
  }
}

function parseWaitForCompletion(value, defaultValue = true) {
  const normalized = value ?? defaultValue;
  if (typeof normalized !== 'boolean') {
    throw agentError('AGENT_VALIDATION_WAIT_FOR_COMPLETION_INVALID', 'waitForCompletion 必须是布尔值', {
      statusCode: 400,
      details: { receivedType: typeof normalized },
      retryable: false
    });
  }
  return normalized;
}

function mapLegacyBusyError(error, legacyCode) {
  if (!error || !legacyCode || error.code !== 'AGENT_EXECUTION_BUSY') return error;
  return agentError(legacyCode, error.message, {
    statusCode: error.statusCode || 409,
    details: error.details || {},
    retryable: error.retryable ?? true
  });
}

function toDailyFlowOutcome(result, legacyBusyCode) {
  const error = createDailyFlowExecutionError(result);
  if (error) return { ok: false, error: mapLegacyBusyError(error, legacyBusyCode) };
  if (result?.stopped) return { stopped: true, result };
  return { ok: true, result };
}

/**
 * Starts a daily flow in the background and resolves once the flow owns the
 * execution lease and has passed the pre-start gate. Failures before that
 * point are reported synchronously; later failures settle the accepted run.
 */
function startDailyFlowBackground({
  scheduleId,
  taskFlow,
  lifecycle,
  runId,
  legacyBusyCode,
  acceptedResult
}) {
  if (typeof lifecycle.onSettled !== 'function') {
    throw new Error('后台日常流程需要 onSettled 生命周期');
  }

  return new Promise((resolve, reject) => {
    let started = false;
    let settled = false;
    const settle = outcome => {
      if (settled) return;
      settled = true;
      Promise.resolve(lifecycle.onSettled(outcome)).catch(error => {
        logger.error('后台日常流程终态处理失败', { scheduleId, runId, error: error.message });
      });
    };

    let flow;
    try {
      flow = executeScheduleNow(scheduleId, taskFlow, {
        onBeforeStart: () => lifecycle.onBeforeStart?.(),
        onStarted: () => {
          started = true;
          lifecycle.onStarted?.();
          resolve(acceptedResult);
        }
      }, { runId });
    } catch (error) {
      reject(error);
      return;
    }

    flow.then(result => {
      const outcome = toDailyFlowOutcome(result, legacyBusyCode);
      if (!started) {
        reject(outcome.error || new Error(outcome.result?.message || '任务流程未能开始'));
        return;
      }
      settle(outcome);
    }, error => {
      if (!started) {
        reject(mapLegacyBusyError(error, legacyBusyCode));
        return;
      }
      settle({ ok: false, error });
    });
  });
}

function executeTrackedDailyFlow(req, res, {
  scheduleId,
  taskFlow,
  waitForCompletion = true,
  metadata,
  legacyBusyCode = null,
  successMessage = '任务流程执行完成',
  acceptedMessage = '任务流程已接受',
  stoppedMessage = result => result?.message || '任务流程已被终止',
  extraResult = {}
}) {
  const totalSteps = taskFlow.filter(task => task?.enabled).length;

  return executeTrackedAgentAction(req, res, {
    operationId: 'run_daily_flow',
    input: { scheduleId, taskFlow },
    waitForCompletion,
    metadata,
    execute: async (lifecycle, { runId }) => {
      if (waitForCompletion) {
        const result = await executeScheduleNow(scheduleId, taskFlow, lifecycle, { runId });
        const failure = createDailyFlowExecutionError(result);
        if (failure) throw mapLegacyBusyError(failure, legacyBusyCode);
        return { ...result, scheduleId, totalSteps, ...extraResult };
      }

      return startDailyFlowBackground({
        scheduleId,
        taskFlow,
        lifecycle,
        runId,
        legacyBusyCode,
        acceptedResult: {
          success: true,
          accepted: true,
          stopped: false,
          message: acceptedMessage,
          scheduleId,
          totalSteps,
          ...extraResult
        }
      });
    },
    successMessage,
    acceptedMessage,
    stoppedMessage
  });
}

/**
 * Starts a copilot set in the background and resolves once it owns the lease
 * and has passed the pre-start gate. Continuous sets settle their Run through
 * the tracked-action lifecycle; manual sets settle their own Run when they
 * reach waiting or a terminal state.
 */
function startCopilotSetBackground({
  runId,
  start,
  lifecycle,
  acceptedResult,
  settleOnFinish
}) {
  return new Promise((resolve, reject) => {
    let started = false;
    let preparedInfo = null;
    const settle = outcome => {
      Promise.resolve(lifecycle.onSettled?.(outcome)).catch(error => {
        logger.error('后台作业集终态处理失败', { runId, error: error.message });
      });
    };
    const wrappedLifecycle = {
      ...lifecycle,
      onPrepared: info => {
        preparedInfo = info;
      },
      onStarted: () => {
        started = true;
        lifecycle.onStarted?.();
        resolve(acceptedResult(preparedInfo));
      }
    };

    let task;
    try {
      task = start(wrappedLifecycle);
    } catch (error) {
      reject(error);
      return;
    }

    task.then(result => {
      if (!started) {
        const run = getAgentRun(runId);
        if (run && (run.state === 'succeeded' || run.state === 'stopped')) {
          resolve(result?.result || result || run.result);
          return;
        }
        reject(new Error(result?.message || '作业集未能开始执行'));
        return;
      }
      if (settleOnFinish) {
        settle({ ok: !result?.stopped, stopped: Boolean(result?.stopped), result });
      }
    }, error => {
      if (!started) {
        reject(error);
        return;
      }
      settle({ ok: false, stopped: Boolean(error?.stopped), error });
    });
  });
}

function executeContinuousCopilotSet(req, res, {
  setId,
  raid,
  selectedIndexes,
  options,
  waitForCompletion
}) {
  return executeTrackedAgentAction(req, res, {
    operationId: 'run_copilot_set',
    input: { setId, mode: 'continuous', raid, selectedIndexes, options },
    metadata: { taskName: `作业集 ${setId}`, taskType: 'copilot-set', setId, mode: 'continuous' },
    waitForCompletion,
    successMessage: result => result?.message || '作业集执行完成',
    acceptedMessage: '作业集任务已接受',
    stoppedMessage: result => result?.message || '作业集已停止',
    execute: async (lifecycle, { runId }) => {
      if (waitForCompletion) {
        return runContinuousCopilotSet({ runId, setId, raid, selectedIndexes, options, lifecycle });
      }
      return startCopilotSetBackground({
        runId,
        start: wrappedLifecycle => runContinuousCopilotSet({
          runId,
          setId,
          raid,
          selectedIndexes,
          options,
          lifecycle: wrappedLifecycle
        }),
        lifecycle,
        settleOnFinish: true,
        acceptedResult: info => ({
          success: true,
          accepted: true,
          stopped: false,
          mode: 'continuous',
          setId,
          name: info?.name || `作业集 ${setId}`,
          totalEntries: info?.totalEntries ?? null,
          message: '作业集任务已接受'
        })
      });
    }
  });
}

function executeManualCopilotSet(req, res, {
  setId,
  raid,
  selectedIndexes,
  options,
  waitForCompletion
}) {
  return executeTrackedAgentAction(req, res, {
    operationId: 'run_copilot_set',
    input: { setId, mode: 'manual', raid, selectedIndexes, options },
    metadata: { taskName: `作业集 ${setId}`, taskType: 'copilot-set', setId, mode: 'manual' },
    waitForCompletion,
    settleOnReturn: false,
    successMessage: result => result?.message || '作业集执行完成',
    acceptedMessage: '作业集任务已接受',
    stoppedMessage: result => result?.message || '作业集已停止',
    execute: async (lifecycle, { runId }) => {
      if (waitForCompletion) {
        const outcome = await startManualCopilotSet({ runId, setId, raid, selectedIndexes, options, lifecycle });
        return outcome.result;
      }
      return startCopilotSetBackground({
        runId,
        start: wrappedLifecycle => startManualCopilotSet({
          runId,
          setId,
          raid,
          selectedIndexes,
          options,
          lifecycle: wrappedLifecycle
        }),
        lifecycle,
        settleOnFinish: false,
        acceptedResult: info => ({
          success: true,
          accepted: true,
          stopped: false,
          mode: 'manual',
          setId,
          name: info?.name || `作业集 ${setId}`,
          totalEntries: info?.totalEntries ?? null,
          message: '作业集任务已接受'
        })
      });
    }
  });
}

function normalizeContinueRunId(req) {
  const requested = req.body?.runId;
  if (typeof requested !== 'string' || !requested.trim()) {
    throw agentError('AGENT_VALIDATION_RUN_ID_INVALID', 'runId 必须是非空字符串', {
      statusCode: 400,
      details: { receivedType: typeof requested },
      retryable: false
    });
  }
  return requested.trim();
}

function settleContinueBackground(runId, outcome) {
  if (!outcome || outcome.ok || outcome.stopped) return;
  const run = getAgentRun(runId);
  if (!run || TERMINAL_RUN_STATES.has(run.state)) return;
  try {
    failAgentRun(runId, outcome.error || new Error('作业集后台执行失败'));
    flushAgentRunStore().catch(error => {
      logger.error('作业集后台失败终态持久化失败', { runId, error: error.message });
    });
  } catch (error) {
    logger.error('作业集后台失败终态写入失败', { runId, error: error.message });
  }
}

function sendContinueSuccess(res, req, runId, outcome) {
  return respondWithPersistedAgentRun(res, req, runId, '作业集下一关状态持久化失败', persistedRun => {
    const run = persistedRun || getAgentRun(runId);
    if (run?.state === 'failed' || run?.state === 'interrupted') {
      return sendRunFailure(res, req, run);
    }
    const enrichedRun = enrichAgentRun(run);
    const data = outcome?.result || run?.result;
    setRunResponseHeaders(res, enrichedRun, false);
    return sendSuccess(
      res,
      req,
      runResponseData(data, enrichedRun),
      data?.message || outcome?.message || '作业集已执行下一关',
      { runId }
    );
  });
}

function respondContinueError(res, req, runId, error) {
  const code = error?.code || '';
  const run = getAgentRun(runId);

  if (code === 'MAA_EXECUTION_BUSY') {
    return sendError(res, req, agentError('MAA_EXECUTION_BUSY', error.message, {
      statusCode: 409,
      details: { owner: error.owner ?? error.details?.owner ?? null, runId, run },
      retryable: true
    }));
  }
  if (code === 'MAA_EXECUTION_SHUTTING_DOWN') {
    return sendError(res, req, agentError('MAA_EXECUTION_SHUTTING_DOWN', error.message, {
      statusCode: 503,
      details: { reason: error.details?.reason ?? null, runId, run },
      retryable: true
    }));
  }
  if (code === 'AGENT_COPILOT_SET_NOT_WAITING' || code === 'AGENT_COPILOT_SET_SESSION_LOST') {
    return sendError(res, req, agentError(code, error.message, {
      statusCode: 409,
      details: { ...(error.details || {}), runId, run },
      retryable: Boolean(error.retryable)
    }));
  }
  if (error?.stopped || run?.state === 'stopped') {
    return sendRunSuccess(res, req, run?.result, run, {
      message: run?.result?.message || '作业集已停止'
    });
  }
  logger.error('作业集下一关执行失败', { runId, error: error?.message });
  return sendError(res, req, agentError('AGENT_COPILOT_SET_CONTINUE_FAILED', error?.message || '作业集下一关执行失败', {
    statusCode: 500,
    details: { runId, run },
    retryable: true
  }));
}

async function continueCopilotSet(req, res, { runId, waitForCompletion }) {
  const run = getAgentRun(runId);
  if (!run) {
    return sendError(res, req, agentError('AGENT_RUN_NOT_FOUND', `未找到 Agent run: ${runId}`, {
      statusCode: 404,
      details: { runId },
      retryable: false
    }));
  }
  if (run.operationId !== 'run_copilot_set') {
    return sendError(res, req, agentError('AGENT_COPILOT_SET_NOT_WAITING', '目标 run 不是作业集执行', {
      statusCode: 409,
      details: { runId, operationId: run.operationId },
      retryable: false
    }));
  }
  if (TERMINAL_RUN_STATES.has(run.state)) {
    return sendSuccess(res, req, {
      runId,
      alreadyTerminal: true,
      waitingForNext: false,
      finished: true,
      run: enrichAgentRun(run)
    }, '作业集已经结束');
  }
  if (run.state !== 'waiting') {
    return sendError(res, req, agentError('AGENT_COPILOT_SET_NOT_WAITING', `作业集当前状态为 ${run.state}`, {
      statusCode: 409,
      details: { runId, state: run.state },
      retryable: true
    }));
  }
  if (!hasCopilotSetSession(runId)) {
    return sendError(res, req, agentError('AGENT_COPILOT_SET_SESSION_LOST', '作业集会话已失效，无法继续下一关', {
      statusCode: 409,
      details: { runId },
      retryable: false
    }));
  }

  if (waitForCompletion) {
    try {
      const outcome = await withExecutionLogContext(
        { runId, operationId: run.operationId },
        () => continueManualCopilotSet({ runId })
      );
      return sendContinueSuccess(res, req, runId, outcome);
    } catch (error) {
      return respondContinueError(res, req, runId, error);
    }
  }

  let accepted;
  try {
    accepted = await startCopilotSetBackground({
      runId,
      start: wrappedLifecycle => withExecutionLogContext(
        { runId, operationId: run.operationId },
        () => continueManualCopilotSet({ runId, lifecycle: wrappedLifecycle })
      ),
      lifecycle: {
        onSettled: outcome => withExecutionLogContext(
          { runId, operationId: run.operationId },
          () => settleContinueBackground(runId, outcome)
        )
      },
      settleOnFinish: false,
      acceptedResult: () => ({
        success: true,
        accepted: true,
        stopped: false,
        mode: 'manual',
        runId,
        message: '作业集下一关已接受'
      })
    });
  } catch (error) {
    return respondContinueError(res, req, runId, error);
  }

  const enrichedRun = enrichAgentRun(getAgentRun(runId));
  setRunResponseHeaders(res, enrichedRun, false, true);
  res.status(202);
  return sendSuccess(res, req, runResponseData(accepted, enrichedRun), accepted.message, { runId });
}

function buildFightArgs({ stages, stage, times, medicine = 0, expiringMedicine = 0, stone = 0, series = 0 } = {}) {
  const rawStages = Array.isArray(stages) ? stages : [{ stage: stage || '', times: times || '' }];
  const stageList = rawStages
    .map(item => typeof item === 'string' ? { stage: item, times: '' } : item)
    .filter(item => item?.stage && String(item.stage).trim())
    .map(item => `${String(item.stage).trim()}${item.times !== undefined && item.times !== '' && item.times !== null ? `:${item.times}` : ''}`)
    .join(',');

  if (!stageList) return [];

  const args = [stageList];
  if (medicine !== undefined && medicine !== '' && medicine !== null) args.push('-m', String(medicine));
  if (expiringMedicine !== undefined && expiringMedicine !== '' && expiringMedicine !== null) args.push('--expiring-medicine', String(expiringMedicine));
  if (stone !== undefined && stone !== '' && stone !== null) args.push('--stone', String(stone));
  if (series !== undefined && series !== '' && series !== null && String(series) !== '1') args.push('--series', String(series));
  return args;
}

async function loadAutomationTaskFlow(overrideTaskFlow = null) {
  if (Array.isArray(overrideTaskFlow)) return overrideTaskFlow;
  const saved = await loadUserConfig('automation-tasks');
  return saved.success && Array.isArray(saved.data?.taskFlow) ? saved.data.taskFlow : [];
}

// 执行路由：注册顺序与抽离前一致，URL、响应与幂等语义不变。
router.post('/activity/run', asyncHandler(async (req, res) => {
  const { clientType } = await resolveRequestConnection(req, { allowOverrides: true });
  return executeTrackedAgentAction(req, res, {
    operationId: 'run_current_activity_copilots',
    input: { clientType },
    metadata: { taskName: '当前活动作业', taskType: 'activity' },
    execute: lifecycle => runCurrentActivityCopilots(clientType, lifecycle),
    successMessage: '当前活动作业执行完成'
  });
}));

router.post('/copilot-sets/:id/execute', asyncHandler(async (req, res) => {
  const setId = String(req.params.id || '').trim();
  if (!setId) {
    return sendError(res, req, agentError('AGENT_VALIDATION_COPILOT_SET_ID_REQUIRED', '作业集 id 不能为空', {
      statusCode: 400,
      retryable: false
    }));
  }
  const { mode, raid, selectedIndexes, options, waitForCompletion } =
    normalizeCopilotSetExecutionRequest(req.body || {});

  if (mode === 'manual') {
    return executeManualCopilotSet(req, res, { setId, raid, selectedIndexes, options, waitForCompletion });
  }
  return executeContinuousCopilotSet(req, res, { setId, raid, selectedIndexes, options, waitForCompletion });
}));

router.post('/actions/continue-copilot-set', asyncHandler(async (req, res) => {
  const runId = normalizeContinueRunId(req);
  const waitForCompletion = parseWaitForCompletion(req.body?.waitForCompletion);
  return continueCopilotSet(req, res, { runId, waitForCompletion });
}));

router.post('/schedules/:scheduleId/execute', asyncHandler(async (req, res) => {
  const { scheduleId } = req.params;
  const { taskFlow } = req.body || {};
  if (!Array.isArray(taskFlow)) {
    return sendError(res, req, agentError('AGENT_VALIDATION_TASK_FLOW_INVALID', '任务流程格式无效', { statusCode: 400 }));
  }
  const waitForCompletion = parseWaitForCompletion(req.body?.waitForCompletion);
  return executeTrackedDailyFlow(req, res, {
    scheduleId,
    taskFlow,
    waitForCompletion,
    metadata: {
      taskName: `任务流程 ${scheduleId}`,
      taskType: 'schedule',
      scheduleId,
      trigger: 'schedule-api'
    },
    legacyBusyCode: 'AGENT_SCHEDULE_ALREADY_RUNNING',
    successMessage: result => result?.message || '任务流程执行完成'
  });
}));

router.post('/actions/start-game', asyncHandler(async (req, res) => {
  const waitForCompletion = parseWaitForCompletion(req.body?.waitForCompletion);
  const { clientType, address } = await resolveRequestConnection(req, { allowOverrides: true })
  return executeTrackedAgentAction(req, res, {
    operationId: 'start_game',
    input: { clientType, address, waitForCompletion },
    waitForCompletion,
    metadata: { taskName: '启动游戏', taskType: 'agent' },
    execute: lifecycle => execMaaCommand(
      'startup',
      [clientType, '-a', address],
      '启动游戏',
      'agent',
      waitForCompletion,
      false,
      lifecycle
    ),
    successMessage: '游戏启动命令执行完成',
    acceptedMessage: '游戏启动命令已接受'
  });
}));

router.post('/actions/run-daily-flow', asyncHandler(async (req, res) => {
  const {
    dryRun,
    scheduleId,
    taskFlow: overrideTaskFlow,
    waitForCompletion
  } = normalizeDailyFlowRequest(req.body || {});
  const taskFlow = await loadAutomationTaskFlow(overrideTaskFlow);
  const planResult = await getScheduledTaskFlowPlan(taskFlow);
  const planError = createDailyFlowExecutionError(planResult);
  if (planError) {
    return sendError(res, req, planError);
  }
  const plan = planResult.steps;

  if (!plan.length) {
    return sendError(res, req, agentError('AGENT_VALIDATION_EMPTY_TASK_FLOW', '没有可执行的自动化任务', {
      statusCode: 400,
      details: { scheduleId },
      retryable: false
    }));
  }

  if (dryRun) {
    return sendSuccess(res, req, {
      dryRun: true,
      scheduleId,
      totalSteps: planResult.totalSteps,
      plan
    }, 'Dry run only', { dryRun: true });
  }

  return executeTrackedDailyFlow(req, res, {
    scheduleId,
    taskFlow,
    waitForCompletion,
    metadata: {
      taskName: `今日流程 ${scheduleId}`,
      taskType: 'schedule',
      scheduleId,
      trigger: 'agent-api'
    },
    successMessage: '今日流程执行完成',
    acceptedMessage: '今日流程已接受',
    extraResult: { plan }
  });
}));

router.post('/actions/fight', asyncHandler(async (req, res) => {
  const { dryRun = false, ...requestOptions } = req.body || {};
  const waitForCompletion = parseWaitForCompletion(requestOptions.waitForCompletion);
  const fightOptions = { ...requestOptions };
  delete fightOptions.waitForCompletion;
  const args = buildFightArgs(fightOptions);
  if (!args.length) {
    return sendError(res, req, agentError('AGENT_VALIDATION_MISSING_STAGES', '至少需要一个有效关卡', {
      statusCode: 400,
      details: { fightOptions },
      retryable: false
    }));
  }
  const plan = {
    command: 'fight',
    args,
    semantic: {
      stages: Array.isArray(fightOptions.stages) ? fightOptions.stages : [{ stage: fightOptions.stage || '', times: fightOptions.times || '' }],
      medicine: fightOptions.medicine ?? 0,
      expiringMedicine: fightOptions.expiringMedicine ?? 0,
      stone: fightOptions.stone ?? 0,
      series: fightOptions.series ?? 0
    }
  };

  if (dryRun) {
    return sendDryRun(res, req, plan);
  }

  return executeTrackedAgentAction(req, res, {
    operationId: 'fight',
    input: { ...plan.semantic, waitForCompletion },
    waitForCompletion,
    metadata: { taskName: 'Agent: 理智作战', taskType: 'agent', plan },
    execute: async lifecycle => ({
      ...(await execMaaCommand(
        'fight',
        args,
        'Agent: 理智作战',
        'agent',
        waitForCompletion,
        false,
        lifecycle
      )),
      plan
    }),
    successMessage: '理智作战执行完成',
    acceptedMessage: '理智作战已接受'
  });
}));

router.post('/actions/run-task', asyncHandler(async (req, res) => {
  const input = req.body || {};
  const requestedWait = parseWaitForCompletion(input.waitForCompletion);
  const waitForCompletion = input.command === 'activity' || input.command === 'list'
    ? true
    : requestedWait;
  return executeTrackedAgentAction(req, res, {
    operationId: 'run_task',
    input: { ...input, waitForCompletion },
    waitForCompletion,
    metadata: { taskName: input.taskName || `Agent: ${input.command || 'task'}`, taskType: input.taskType || 'agent' },
    execute: lifecycle => executeAgentTask(
      { ...input, waitForCompletion },
      {
        execMaaCommand: (command, args, taskName, taskType, shouldWait, silent = false) =>
          execMaaCommand(command, args, taskName, taskType, shouldWait, silent, lifecycle),
        execDynamicTask: (taskId, taskConfig, taskName, taskType, shouldWait, userResource) =>
          execDynamicTask(taskId, taskConfig, taskName, taskType, shouldWait, userResource, { lifecycle })
      }
    ),
    successMessage: '任务执行完成',
    acceptedMessage: '任务已接受'
  });
}));

function normalizeRequestedRunId(req) {
  const requested = req.body?.runId ?? req.query?.runId ?? null;
  if (requested === null) return null;
  if (typeof requested !== 'string' || !requested.trim()) {
    throw agentError('AGENT_VALIDATION_RUN_ID_INVALID', 'runId 必须是非空字符串', {
      statusCode: 400,
      details: { receivedType: typeof requested },
      retryable: false
    });
  }
  return requested.trim();
}

function sendStopSuccess(res, req, runId, data, message) {
  return respondWithPersistedAgentRun(
    res,
    req,
    runId,
    'Agent run 停止状态持久化失败',
    persistedRun => sendSuccess(res, req, {
      ...data,
      run: enrichAgentRun(persistedRun || data.run)
    }, message)
  );
}

async function stopRequestedRun(res, req, requestedRunId) {
  const requestedRun = getAgentRun(requestedRunId);
  if (!requestedRun) {
    return sendError(res, req, agentError('AGENT_RUN_NOT_FOUND', `未找到 Agent run: ${requestedRunId}`, {
      statusCode: 404,
      details: { runId: requestedRunId },
      retryable: false
    }));
  }
  if (TERMINAL_RUN_STATES.has(requestedRun.state)) {
    return sendSuccess(res, req, {
      stopRequested: false,
      deviceStopRequested: false,
      alreadyTerminal: true,
      run: requestedRun
    }, '任务已经结束');
  }

  if (requestedRun.operationId === 'run_copilot_set') {
    const setStop = requestCopilotSetRunStop(requestedRunId);
    if (setStop?.disposition === 'stopped') {
      return sendStopSuccess(res, req, setStop.run.runId, {
        stopRequested: true,
        deviceStopRequested: false,
        waitingRunStopped: true,
        run: setStop.run
      }, '作业集已停止，未开始下一关');
    }
    if (setStop?.disposition === 'canceled') {
      return sendStopSuccess(res, req, setStop.run.runId, {
        stopRequested: true,
        deviceStopRequested: false,
        acceptedRunCanceled: true,
        run: setStop.run
      }, '已取消尚未开始的作业集执行');
    }
  }

  // Accepted runs hold no execution rights: canceling them is safe and
  // cannot touch a newer execution.
  if (requestedRun.state === 'accepted') {
    const { run } = requestAgentRunStop(requestedRunId);
    return sendStopSuccess(res, req, run.runId, {
      stopRequested: true,
      deviceStopRequested: false,
      acceptedRunCanceled: true,
      run
    }, '已取消尚未开始的执行');
  }

  const currentRun = getCurrentAgentRun();
  if (!currentRun || currentRun.runId !== requestedRunId) {
    if (requestedRun.state === 'stopping') {
      return sendSuccess(res, req, {
        stopRequested: true,
        deviceStopRequested: false,
        alreadyStopping: true,
        run: requestedRun
      }, '任务正在终止');
    }
    return sendError(res, req, agentError('AGENT_RUN_NOT_CURRENT', '目标 run 不是当前执行，未发送终止命令', {
      statusCode: 409,
      details: { requestedRunId, currentRunId: currentRun?.runId || null },
      retryable: false
    }));
  }

  const task = stopCurrentTask();
  const scheduleStopped = stopScheduleExecution();
  const deviceStopRequested = task.success || scheduleStopped;
  const { run } = requestAgentRunStop(requestedRunId);
  return sendStopSuccess(res, req, run.runId, {
    task,
    scheduleStopped,
    stopRequested: true,
    deviceStopRequested,
    run
  }, '已发送终止请求');
}

async function stopCurrentExecution(res, req) {
  const task = stopCurrentTask();
  const scheduleStopped = stopScheduleExecution();
  const deviceStopRequested = task.success || scheduleStopped;
  const currentRun = getCurrentAgentRun();

  if (currentRun?.operationId === 'run_copilot_set') {
    const setStop = requestCopilotSetRunStop(currentRun.runId);
    if (setStop?.disposition === 'stopped' || setStop?.disposition === 'canceled') {
      const canceled = setStop.disposition === 'canceled';
      return sendStopSuccess(res, req, setStop.run.runId, {
        task,
        scheduleStopped,
        stopRequested: true,
        deviceStopRequested,
        ...(canceled ? { acceptedRunCanceled: true } : { waitingRunStopped: true }),
        run: setStop.run
      }, canceled ? '已取消尚未开始的作业集执行' : '作业集已停止，未开始下一关');
    }
  }

  if (currentRun && ACTIVE_RUN_STATES.has(currentRun.state)) {
    const { run, disposition } = requestAgentRunStop(currentRun.runId);
    const acceptedRunCanceled = disposition === 'canceled';
    return sendStopSuccess(res, req, run.runId, {
      task,
      scheduleStopped,
      stopRequested: true,
      deviceStopRequested,
      ...(acceptedRunCanceled ? { acceptedRunCanceled: true } : {}),
      run
    }, acceptedRunCanceled ? '已取消尚未开始的执行' : '已发送终止请求');
  }

  return sendSuccess(res, req, {
    task,
    scheduleStopped,
    stopRequested: deviceStopRequested,
    deviceStopRequested,
    run: enrichAgentRun(currentRun)
  }, deviceStopRequested ? '已发送终止请求' : '当前没有可终止的任务');
}

router.post('/actions/stop', asyncHandler(async (req, res) => {
  const requestedRunId = normalizeRequestedRunId(req);
  if (requestedRunId) return stopRequestedRun(res, req, requestedRunId);
  return stopCurrentExecution(res, req);
}));

export default router;
