import { execFile } from 'child_process';
import { promisify } from 'util';
import { getMaaVersion } from '../services/maaExecutionService.ts';
import type { MaaProcessLifecycle } from '../services/maaProcessService.ts';
import { testAdbConnection, discoverAdbDevices } from '../services/maaDeviceService.ts';
import { getMaaConfigDir, getProfile, saveProfile as saveMaaProfile } from '../services/maaConfigService.ts';
import { getCurrentActivity } from '../services/maaActivityService.ts';
import type { MaaActivitySnapshot } from '../services/maaActivityService.ts';
import { getScheduleExecutionStatus, getScheduleStatus, setupSchedule, stopSchedule, setupAutoUpdate, getAutoUpdateStatus } from '../services/schedulerService.ts';
import {
  createResourceUpdateInProgressError,
  getMaaResourceInfo,
  RESOURCE_UPDATE_IN_PROGRESS_CODE
} from '../services/resourceUpdateService.ts';
import { readResourceSourceConfig, saveResourceSourceConfig } from '../services/resourceSourceService.ts';
import { buildCliUpdaterPlan, runCliUpdater } from '../services/cliUpdaterService.ts';
import {
  CORE_UPDATE_TASK_NAME,
  CLI_UPDATE_TASK_NAME,
  RESOURCE_UPDATE_TASK_NAME,
  UPDATE_OPERATION_IDS,
  runCliUpdate,
  runCoreUpdate,
  runResourceUpdate
} from '../services/updateExecutionService.ts';
import { getActiveAgentRuns } from '../services/agentRunService.ts';
import type { AgentRunDto } from '../services/agentRunService.ts';
import type {
  CliUpdateRunResult,
  CoreUpdateRunResult,
  ResourceUpdateRunResult
} from '../services/updateExecutionService.ts';
import {
  isCliUpdateChannel,
  isCoreUpdateChannel,
  readCliUpdateCapabilities,
  readUpdateChannels,
  saveUpdateChannel
} from '../services/updateChannelService.ts';
import type { CoreUpdateChannel } from '../services/updateChannelService.ts';
import { parseDepotData, parseOperBoxData } from '../services/dataParserService.ts';
import { loadParadoxOperators, resolveStageSearchKeyword } from '../services/copilotService.ts';
import { buildCopilotPlan, resetCopilotPlanProgress } from '../services/copilotPlanService.ts';
import { getActivityCompletion } from '../services/activityCompletionService.ts';
import { createOutboundHttpClient } from '../services/outboundRequestService.ts';
import { executeTrackedAgentAction } from './agentExecutionController.ts';
import type { ExecutionOutcome, TrackedExecutionLifecycle } from './agentExecutionController.ts';
import {
  agentError,
  sendSuccess,
  sendDryRun,
  sendError
} from '../utils/apiHelper.ts';
import type {
  ApiErrorResponse,
  ApiResponseWriter,
  ApiSuccessResponse
} from '../utils/apiHelper.ts';
import { createLogger } from '../utils/logger.ts'
import {
  parseAutoUpdateBody,
  parseCopilotPlanQuery,
  parseCopilotSearchQuery,
  parseDryRunBody,
  parseGithubReleaseList,
  parseMaaProfileBody,
  parseParadoxSearchQuery,
  parsePrtsCopilotQueryPayload,
  parseScheduleSetupBody,
  parseUpdateChannelBody,
  parseUpdateCliBody,
  parseUpdateCoreBody,
  parseUpdateWaitForCompletion,
  projectCopilotSearchItem,
  projectParadoxCopilot,
  resolveMaintenanceConnection,
  resourceInfoFallback,
  thrownMessage,
  toChangelogEntry
} from './maintenanceDto.ts';
import type {
  MaintenanceActivityPayload,
  MaintenanceChangelogEntry,
  MaintenanceConfigDirectoryPayload,
  MaintenanceCopilotRequest,
  MaintenanceCopilotSearchEntry,
  MaintenanceCopilotSearchPayload,
  MaintenanceHotUpdateResourcesPayload,
  MaintenanceHotUpdateResourcesPlan,
  MaintenanceOpenConfigDirectoryPayload,
  MaintenanceParadoxSearchPayload,
  MaintenanceProfileRequest,
  MaintenanceRecognitionPlan,
  MaintenanceRequest,
  MaintenanceScheduleStopRequest,
  MaintenanceUpdateCliPayload,
  MaintenanceUpdateCliPlan,
  MaintenanceUpdateCorePayload,
  MaintenanceUpdateCorePlan,
  MaintenanceUpdatePlanStep,
  MaintenanceVersionPayload
} from './maintenanceDto.ts';

const execFileAsync = promisify(execFile);
const logger = createLogger('AgentRoutes');

/** 识别解析服务已返回统一 envelope；HTTP 适配只保留一层信封并还原载荷。 */
type RecognitionParseResult<T> = ApiSuccessResponse<T> | ApiErrorResponse | null;

function sendRecognitionResult<T>(
  res: ApiResponseWriter,
  req: MaintenanceRequest,
  result: RecognitionParseResult<T>,
  label: string
): void {
  if (result === null) {
    return sendError(res, req, agentError('AGENT_RECOGNITION_NO_RESULT', `未找到有效的${label}识别结果`, {
      statusCode: 422,
      retryable: true
    }));
  }
  if (!result.success) {
    sendError(res, req, agentError(result.error.code, result.message, {
      statusCode: 500,
      details: result.error.details,
      retryable: result.error.retryable
    }), result.message);
    return;
  }
  sendSuccess(res, req, result.data, `${label}识别完成`);
}

// 出站读取入口（changelog/copilot/paradox 查询）统一经出站端口：
// 显式时限、取消与受限重试由端口承担，错误经 asyncHandler 进入统一错误出口。
const outboundHttp = createOutboundHttpClient();

export async function readProfile(req: MaintenanceProfileRequest, res: ApiResponseWriter): Promise<void> {
  return sendSuccess(res, req, await getProfile(req.params.profileName));
}

export async function saveProfile(req: MaintenanceProfileRequest, res: ApiResponseWriter): Promise<void> {
  await saveMaaProfile(req.params.profileName, parseMaaProfileBody(req.body));
  return sendSuccess(res, req, null, '配置保存成功');
}

function activityStatusMessage(activity: MaaActivitySnapshot): string {
  const label = activity.name || activity.code || '未知活动';
  switch (activity.status) {
    case 'active':
      return `当前活动: ${label}`;
    case 'none':
      return '当前没有刷关活动';
    case 'stale':
      return `活动信息可能已过期: ${label}`;
    case 'unavailable':
    default:
      return `无法获取活动信息: ${activity.failure?.message || '未知原因'}`;
  }
}

export async function readActivity(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  const { clientType } = await resolveMaintenanceConnection(req);
  const activityInfo = await getCurrentActivity(clientType);
  const completion = await getActivityCompletion(activityInfo);
  const payload: MaintenanceActivityPayload = {
    code: activityInfo.code,
    name: activityInfo.name,
    source: activityInfo.source || null,
    startTime: activityInfo.startTime || null,
    endTime: activityInfo.endTime || null,
    stages: activityInfo.stages || [],
    rerun: activityInfo.rerun,
    activities: activityInfo.activities,
    completion,
    available: !!activityInfo.code,
    message: activityStatusMessage(activityInfo),
    status: activityInfo.status,
    clientType: activityInfo.clientType,
    lastSuccessAt: activityInfo.lastSuccessAt,
    dataUpdatedAt: activityInfo.dataUpdatedAt,
    failure: activityInfo.failure
  };
  return sendSuccess(res, req, payload);
}

export async function runDepotRecognition(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  const plan: MaintenanceRecognitionPlan = {
    action: 'depot-recognition',
    sideEffects: ['parse_maa_logs', 'update_local_depot_cache']
  };
  if (parseDryRunBody(req.body).dryRun) {
    return sendDryRun(res, req, plan);
  }
  return sendRecognitionResult(res, req, await parseDepotData(), '仓库');
}

export async function runOperboxRecognition(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  const plan: MaintenanceRecognitionPlan = {
    action: 'operbox-recognition',
    sideEffects: ['parse_maa_logs', 'update_local_operbox_cache']
  };
  if (parseDryRunBody(req.body).dryRun) {
    return sendDryRun(res, req, plan);
  }
  return sendRecognitionResult(res, req, await parseOperBoxData(), '干员');
}

export async function readCoreChangelog(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  try {
    const { data } = await outboundHttp.requestJson(
      `https://api.github.com/repos/MaaAssistantArknights/MaaAssistantArknights/releases?per_page=100`,
      {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'MAA-WebUI'
        }
      }
    );

    const releases = parseGithubReleaseList(data);
    const latestBeta = releases.find(release => release.prerelease);
    const latestStable = releases.find(release => !release.prerelease);

    const changelog: MaintenanceChangelogEntry[] = [];

    if (latestBeta) {
      changelog.push(toChangelogEntry(latestBeta));
    }

    if (latestStable) {
      changelog.push(toChangelogEntry(latestStable));
    }

    return sendSuccess(res, req, changelog);
  } catch (error) {
    return sendError(res, req, agentError('AGENT_CHANGELOG_CORE_FETCH_FAILED', `获取 MaaCore 更新日志失败: ${thrownMessage(error)}`, {
      statusCode: 502,
      details: { provider: 'github', target: 'MaaAssistantArknights' },
      retryable: true
    }));
  }
}

export async function readCliChangelog(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  try {
    const { data } = await outboundHttp.requestJson(
      `https://api.github.com/repos/MaaAssistantArknights/maa-cli/releases?per_page=100`,
      {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'MAA-WebUI'
        }
      }
    );
    const releases = parseGithubReleaseList(data);
    const latestStable = releases.find(release => !release.prerelease);

    const changelog: MaintenanceChangelogEntry[] = latestStable ? [toChangelogEntry(latestStable)] : [];

    return sendSuccess(res, req, changelog);
  } catch (error) {
    return sendError(res, req, agentError('AGENT_CHANGELOG_CLI_FETCH_FAILED', `获取 MAA CLI 更新日志失败: ${thrownMessage(error)}`, {
      statusCode: 502,
      details: { provider: 'github', target: 'maa-cli' },
      retryable: true
    }));
  }
}

export async function readCopilot(req: MaintenanceCopilotRequest, res: ApiResponseWriter): Promise<void> {
  const { data } = await outboundHttp.requestJson(`https://prts.maa.plus/copilot/get/${req.params.id}`);
  return sendSuccess(res, req, data);
}

export async function readCopilotSet(req: MaintenanceCopilotRequest, res: ApiResponseWriter): Promise<void> {
  const { data } = await outboundHttp.requestJson(`https://prts.maa.plus/set/get?id=${encodeURIComponent(req.params.id)}`);
  return sendSuccess(res, req, data);
}

export async function readCopilotSetPlan(req: MaintenanceCopilotRequest, res: ApiResponseWriter): Promise<void> {
  const { raid } = parseCopilotPlanQuery(req.query);
  return sendSuccess(res, req, await buildCopilotPlan(req.params.id, raid));
}

export async function resetCopilotSetProgress(req: MaintenanceCopilotRequest, res: ApiResponseWriter): Promise<void> {
  return sendSuccess(res, req, await resetCopilotPlanProgress(req.params.id));
}

export async function searchParadox(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  const { name } = parseParadoxSearchQuery(req.query);
  if (!name) {
    return sendError(res, req, agentError('AGENT_VALIDATION_OPERATOR_NAME_REQUIRED', '请提供干员名字', { statusCode: 400 }));
  }

  const paradoxData = await loadParadoxOperators();
  const operator = paradoxData.find(op => op.name.includes(name) || name.includes(op.name));
  if (!operator) {
    return sendError(res, req, agentError('AGENT_PARADOX_OPERATOR_NOT_FOUND', `未找到干员"${name}"的悖论模拟关卡`, { statusCode: 404, details: { name } }));
  }

  const { data } = await outboundHttp.requestJson(`https://prts.maa.plus/copilot/query?level_keyword=${operator.stage_id}&page=1&limit=10&order_by=hot`);
  const result = parsePrtsCopilotQueryPayload(data);
  if (result.statusCode !== 200 || !result.items.length) {
    return sendError(res, req, agentError('AGENT_PARADOX_COPILOT_NOT_FOUND', `未找到干员"${operator.name}"的作业`, { statusCode: 404, details: { operator: operator.name, stageId: operator.stage_id } }));
  }

  const copilots = result.items.map(projectParadoxCopilot);

  const payload: MaintenanceParadoxSearchPayload = {
    operator: operator.name,
    stageId: operator.stage_id,
    copilots,
    recommended: copilots[0]
  };
  return sendSuccess(res, req, payload);
}

export async function searchCopilot(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  const { stage } = parseCopilotSearchQuery(req.query);
  if (!stage) {
    return sendError(res, req, agentError('AGENT_VALIDATION_STAGE_REQUIRED', '请提供关卡名称', { statusCode: 400 }));
  }

  const normalizedStage = stage.toUpperCase();
  const searchKeyword = await resolveStageSearchKeyword(stage);
  const allCopilots: MaintenanceCopilotSearchEntry[] = [];
  let page = 1;
  const maxPages = 5;
  const targetCount = 10;

  while (page <= maxPages && allCopilots.length < targetCount) {
    const { data } = await outboundHttp.requestJson(`https://prts.maa.plus/copilot/query?level_keyword=${encodeURIComponent(searchKeyword)}&page=${page}&limit=50&order_by=hot`);
    const result = parsePrtsCopilotQueryPayload(data);
    if (result.statusCode !== 200 || !result.items.length) break;

    for (const candidate of result.items.map(item => projectCopilotSearchItem(item, stage))) {
      const normalizedStageName = String(candidate.entry.stageName || '').trim().toUpperCase();
      const normalizedSearchKeyword = String(searchKeyword || '').trim().toUpperCase();
      if (normalizedStageName === normalizedStage || normalizedStageName === normalizedSearchKeyword || candidate.titleStageCode === normalizedStage) {
        allCopilots.push(candidate.entry);
      }
    }

    if (!result.hasNext) break;
    page += 1;
  }

  if (!allCopilots.length) {
    return sendError(res, req, agentError('AGENT_COPILOT_NOT_FOUND', `未找到关卡"${stage}"的作业`, { statusCode: 404, details: { stage, searchKeyword } }));
  }

  const payload: MaintenanceCopilotSearchPayload = {
    stage,
    copilots: allCopilots.slice(0, targetCount),
    recommended: allCopilots[0]
  };
  return sendSuccess(res, req, payload);
}

export async function readParadoxOperators(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  return sendSuccess(res, req, await loadParadoxOperators());
}

export async function readScheduleStatus(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  return sendSuccess(res, req, getScheduleStatus());
}

export async function readScheduleExecutionStatus(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  return sendSuccess(res, req, getScheduleExecutionStatus());
}

export async function registerSchedule(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  const { scheduleId, times, taskFlow } = parseScheduleSetupBody(req.body);
  // 执行时间按连接 profile 的客户端服务区时区触发；请求体与响应形状不变。
  const { clientType } = await resolveMaintenanceConnection(req);
  const result = setupSchedule(scheduleId, times, taskFlow, clientType);
  if (!result.success) {
    return sendError(res, req, agentError('AGENT_SCHEDULE_SETUP_FAILED', result.message, { statusCode: 400 }));
  }
  return sendSuccess(res, req, result, result.message);
}

export async function stopScheduleById(req: MaintenanceScheduleStopRequest, res: ApiResponseWriter): Promise<void> {
  return sendSuccess(res, req, stopSchedule(req.params.scheduleId));
}

export async function configureAutoUpdate(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  return sendSuccess(res, req, setupAutoUpdate(parseAutoUpdateBody(req.body)));
}

export async function readAutoUpdateStatus(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  return sendSuccess(res, req, getAutoUpdateStatus());
}

export async function openConfigDirectory(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  const configDir = await getMaaConfigDir();
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'explorer.exe'
      : 'xdg-open';
  await execFileAsync(command, [configDir]);
  const payload: MaintenanceOpenConfigDirectoryPayload = { configDir };
  return sendSuccess(res, req, payload, '配置目录已打开');
}

function toUpdateProcessLifecycle(lifecycle: TrackedExecutionLifecycle): MaaProcessLifecycle {
  return {
    onBeforeStart: () => lifecycle.onBeforeStart?.(),
    onStarted: () => lifecycle.onStarted?.(),
    ...(lifecycle.onSettled
      ? {
          onSettled: outcome => lifecycle.onSettled?.({
            ok: outcome.ok,
            stopped: outcome.stopped,
            result: outcome.result,
            error: outcome.error
          })
        }
      : {})
  };
}

interface StartTrackedUpdateOptions {
  label: string;
  acceptedResult: unknown;
  lifecycle: TrackedExecutionLifecycle;
  task: (lifecycle: MaaProcessLifecycle) => Promise<unknown>;
}

function errorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function findActiveResourceUpdateRun(rejectedRunId: string): AgentRunDto | null {
  try {
    return getActiveAgentRuns().find(run => (
      run.operationId === UPDATE_OPERATION_IDS.resources && run.runId !== rejectedRunId
    )) ?? null;
  } catch (error) {
    logger.error('读取进行中的资源更新 run 失败', { error: thrownMessage(error) });
    return null;
  }
}

function describeActiveRunState(state: string): string {
  switch (state) {
    case 'accepted':
      return '已接受，等待开始';
    case 'waiting':
      return '等待执行';
    case 'running':
      return '执行中';
    case 'stopping':
      return '停止中';
    default:
      return state;
  }
}

/**
 * 并发资源更新冲突：把正在进行的更新 run 身份补进 409 响应，调用方可据此等待或观察；
 * 被拒绝的 run 仍按执行前拒绝写入 failed 终态，且不启动第二次更新。
 */
function describeResourceUpdateConflict(error: unknown, rejectedRunId: string): unknown {
  if (errorCodeOf(error) !== RESOURCE_UPDATE_IN_PROGRESS_CODE) return error;
  const active = findActiveResourceUpdateRun(rejectedRunId);
  const message = active
    ? `已有资源更新正在进行（runId: ${active.runId}，状态：${describeActiveRunState(active.state)}），请等待当前更新完成`
    : '已有资源更新正在进行，请等待当前更新完成';
  return createResourceUpdateInProgressError(message, {
    activeRunId: active?.runId ?? null,
    activeRunState: active?.state ?? null
  });
}

/**
 * 后台更新：`onBeforeStart` 只通过 Run 的准入门禁，等子进程真正就绪后的
 * `onStarted` 再标记开始、复查 Run 状态并返回接受载荷；这样 202 与 spawn
 * 之间到达的停止请求仍能终止刚启动的子进程。实际结果经 onSettled 收尾。
 */
function startTrackedUpdate({
  label,
  acceptedResult,
  lifecycle,
  task
}: StartTrackedUpdateOptions): Promise<unknown> {
  if (typeof lifecycle.onSettled !== 'function') {
    throw new Error('后台更新需要 onSettled 生命周期');
  }

  return new Promise((resolve, reject) => {
    let started = false;
    let settled = false;
    const settle = (outcome: ExecutionOutcome): void => {
      if (settled) return;
      settled = true;
      Promise.resolve(lifecycle.onSettled?.(outcome)).catch(error => {
        logger.error(`${label}终态处理失败`, { error: thrownMessage(error) });
      });
    };
    const updateLifecycle: MaaProcessLifecycle = {
      onBeforeStart: () => lifecycle.onBeforeStart?.(),
      onStarted: () => {
        if (started) return;
        started = true;
        lifecycle.onStarted?.();
        resolve(acceptedResult);
      }
    };

    let running: Promise<unknown>;
    try {
      running = task(updateLifecycle);
    } catch (error) {
      reject(error);
      return;
    }
    running.then(result => {
      if (!started) {
        reject(new Error(`${label}未能开始`));
        return;
      }
      settle({ ok: true, result });
    }, error => {
      if (!started) {
        reject(error);
        return;
      }
      settle({ ok: false, error });
    });
  });
}

function coreUpdatePayload(
  plan: MaintenanceUpdateCorePlan,
  result: CoreUpdateRunResult
): MaintenanceUpdateCorePayload {
  return {
    plan,
    steps: {
      core: { success: true, output: result.output },
      resources: { success: result.resource.status !== 'unknown', output: '' }
    },
    channelPersisted: result.channelPersisted,
    runtime: { ...result.runtime, resource: result.resource }
  };
}

/** 渠道持久化失败不改变更新成功结论，但成功文案不能声称已切换渠道。 */
function coreUpdateSuccessMessage(result: unknown, requestedChannel: CoreUpdateChannel | null): string {
  const channelPersisted = !(typeof result === 'object'
    && result !== null
    && 'channelPersisted' in result
    && result.channelPersisted === false);
  if (requestedChannel) {
    return channelPersisted
      ? `已切换到 ${requestedChannel} 渠道并同步最新资源`
      : `MaaCore 已更新并同步最新资源，但 ${requestedChannel} 渠道配置未能持久化，后续更新可能仍使用原渠道`;
  }
  return channelPersisted ? 'MaaCore 和资源已更新' : 'MaaCore 和资源已更新，但渠道配置未能持久化';
}

function cliUpdatePayload(
  plan: MaintenanceUpdateCliPlan,
  result: CliUpdateRunResult
): MaintenanceUpdateCliPayload {
  return { output: result.output, plan };
}

function resourceUpdatePayload(
  plan: MaintenanceHotUpdateResourcesPlan,
  result: ResourceUpdateRunResult
): MaintenanceHotUpdateResourcesPayload {
  return { ...result, plan };
}

export async function updateCore(req: MaintenanceRequest, res: ApiResponseWriter): Promise<unknown> {
  const { version, dryRun } = parseUpdateCoreBody(req.body);
  const waitForCompletion = parseUpdateWaitForCompletion(req.body);
  const requestedChannel = isCoreUpdateChannel(version) ? version : null;
  if (version !== undefined && version !== null && requestedChannel === null) {
    return sendError(res, req, agentError('AGENT_MAA_UPDATE_CORE_CHANNEL_INVALID', '不支持的 MaaCore 更新渠道', {
      statusCode: 400,
      details: { version }
    }));
  }
  const targetChannel = requestedChannel ?? (version === undefined
    ? (await readUpdateChannels()).core
    : 'current');
  const corePlan: MaintenanceUpdatePlanStep = requestedChannel
    ? { action: 'update-core', targetChannel: requestedChannel, command: 'install', args: [requestedChannel, '--force'] }
    : { action: 'update-core', targetChannel, command: 'update', args: [] };
  const plan: MaintenanceUpdateCorePlan = {
    action: 'update-core-and-resources',
    steps: [corePlan]
  };

  if (dryRun) return sendDryRun(res, req, plan);

  return executeTrackedAgentAction(req, res, {
    operationId: 'update_core',
    input: { version: version ?? null, targetChannel, waitForCompletion },
    waitForCompletion,
    metadata: { taskName: CORE_UPDATE_TASK_NAME, taskType: 'maintenance', targetChannel },
    execute: lifecycle => {
      const run = async (updateLifecycle: MaaProcessLifecycle): Promise<MaintenanceUpdateCorePayload> => {
        const result = await runCoreUpdate({ requestedChannel, version, lifecycle: updateLifecycle });
        return coreUpdatePayload(plan, result);
      };
      if (waitForCompletion) return run(toUpdateProcessLifecycle(lifecycle));
      return startTrackedUpdate({
        label: 'MaaCore 更新',
        acceptedResult: { accepted: true, plan, targetChannel },
        lifecycle,
        task: run
      });
    },
    successMessage: result => coreUpdateSuccessMessage(result, requestedChannel),
    acceptedMessage: 'MaaCore 更新已接受',
    stoppedMessage: 'MaaCore 更新已终止'
  });
}

export async function updateCli(req: MaintenanceRequest, res: ApiResponseWriter): Promise<unknown> {
  const { channel, dryRun } = parseUpdateCliBody(req.body);
  const waitForCompletion = parseUpdateWaitForCompletion(req.body);
  const explicitChannel = isCliUpdateChannel(channel) ? channel : null;
  if (channel !== undefined && explicitChannel === null) {
    return sendError(res, req, agentError('AGENT_MAA_UPDATE_CLI_CHANNEL_INVALID', '不支持的 MAA CLI 更新渠道', {
      statusCode: 400,
      details: { channel }
    }));
  }
  const channels = await readUpdateChannels();
  const targetChannel = explicitChannel ?? channels.cli;
  const capabilities = await readCliUpdateCapabilities();
  const updater = await buildCliUpdaterPlan(targetChannel, {
    binaryEnabled: capabilities.binary,
    force: explicitChannel !== null && explicitChannel !== channels.cli
  });
  const plan: MaintenanceUpdateCliPlan = {
    action: 'update-cli',
    command: updater.command,
    args: updater.args,
    channel: updater.channel,
    source: updater.source,
    supported: updater.supported,
    ...(updater.reason ? { reason: updater.reason } : {})
  };
  if (dryRun) return sendDryRun(res, req, plan);
  if (!updater.supported) {
    return sendError(res, req, agentError('AGENT_MAA_UPDATE_CLI_UNSUPPORTED', updater.reason || '当前安装来源不支持更新 MAA CLI', {
      statusCode: 409,
      retryable: false,
      details: { channel: targetChannel, source: updater.source }
    }));
  }

  return executeTrackedAgentAction(req, res, {
    operationId: 'update_cli',
    input: { channel: explicitChannel, targetChannel, waitForCompletion },
    waitForCompletion,
    metadata: { taskName: CLI_UPDATE_TASK_NAME, taskType: 'maintenance', targetChannel, source: updater.source },
    execute: lifecycle => {
      const run = async (updateLifecycle: MaaProcessLifecycle): Promise<MaintenanceUpdateCliPayload> => {
        const result = await runCliUpdate({
          updater,
          channel: targetChannel,
          explicitChannel,
          lifecycle: updateLifecycle
        });
        return cliUpdatePayload(plan, result);
      };
      if (waitForCompletion) return run(toUpdateProcessLifecycle(lifecycle));
      return startTrackedUpdate({
        label: 'MAA CLI 更新',
        acceptedResult: { accepted: true, plan, channel: targetChannel, source: updater.source },
        lifecycle,
        task: run
      });
    },
    successMessage: `MAA CLI 更新完成（${updater.channel} 渠道）`,
    acceptedMessage: 'MAA CLI 更新已接受',
    stoppedMessage: 'MAA CLI 更新已终止'
  });
}

export async function hotUpdateResources(req: MaintenanceRequest, res: ApiResponseWriter): Promise<unknown> {
  const plan: MaintenanceHotUpdateResourcesPlan = { action: 'hot-update-resources', command: 'hot-update' };
  if (parseDryRunBody(req.body).dryRun) return sendDryRun(res, req, plan);
  const waitForCompletion = parseUpdateWaitForCompletion(req.body);

  return executeTrackedAgentAction(req, res, {
    operationId: 'update_resources',
    input: { waitForCompletion },
    waitForCompletion,
    metadata: { taskName: RESOURCE_UPDATE_TASK_NAME, taskType: 'maintenance' },
    execute: (lifecycle, { runId }) => {
      const run = async (updateLifecycle: MaaProcessLifecycle): Promise<MaintenanceHotUpdateResourcesPayload> => {
        const result = await runResourceUpdate({ lifecycle: updateLifecycle });
        return resourceUpdatePayload(plan, result);
      };
      const started = waitForCompletion
        ? run(toUpdateProcessLifecycle(lifecycle))
        : startTrackedUpdate({
            label: '资源更新',
            acceptedResult: { accepted: true, plan },
            lifecycle,
            task: run
          });
      return started.catch(error => {
        throw describeResourceUpdateConflict(error, runId);
      });
    },
    successMessage: '资源文件更新成功',
    acceptedMessage: '资源更新已接受',
    stoppedMessage: '资源同步已终止'
  });
}

export async function testConnection(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  const { adbPath, address } = await resolveMaintenanceConnection(req)
  return sendSuccess(res, req, await testAdbConnection(adbPath, address));
}

export async function discoverDevices(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  const { adbPath } = await resolveMaintenanceConnection(req)
  return sendSuccess(res, req, await discoverAdbDevices(adbPath));
}

export async function readVersion(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  const [version, resource, updateChannels] = await Promise.all([
    getMaaVersion(true),
    getMaaResourceInfo().catch(resourceInfoFallback),
    readUpdateChannels()
  ]);
  const payload: MaintenanceVersionPayload = { ...version, resource, updateChannels };
  return sendSuccess(res, req, payload);
}

export async function readChannels(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  return sendSuccess(res, req, await readUpdateChannels());
}

export async function readResourceSource(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  return sendSuccess(res, req, await readResourceSourceConfig());
}

export async function saveResourceSource(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  return sendSuccess(res, req, await saveResourceSourceConfig(req.body), '资源源配置已保存');
}

export async function saveChannel(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  const { scope, channel } = parseUpdateChannelBody(req.body);
  const targetScope = scope === 'core' || scope === 'cli' ? scope : null;
  if (!targetScope) {
    return sendError(res, req, agentError('AGENT_UPDATE_CHANNEL_SCOPE_INVALID', '更新渠道作用域不合法', {
      statusCode: 400,
      details: { scope }
    }));
  }
  const validChannel = targetScope === 'core' ? isCoreUpdateChannel(channel) : isCliUpdateChannel(channel);
  if (!validChannel) {
    return sendError(res, req, agentError('AGENT_UPDATE_CHANNEL_INVALID', '更新渠道不合法', {
      statusCode: 400,
      details: { scope: targetScope, channel }
    }));
  }
  return sendSuccess(res, req, await saveUpdateChannel(targetScope, channel), '更新渠道已保存');
}

export async function readConfigDirectory(req: MaintenanceRequest, res: ApiResponseWriter): Promise<void> {
  const payload: MaintenanceConfigDirectoryPayload = { path: await getMaaConfigDir() };
  return sendSuccess(res, req, payload);
}
