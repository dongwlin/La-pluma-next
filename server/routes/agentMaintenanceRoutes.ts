import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { execMaaCommand, getMaaVersion } from '../services/maaExecutionService.ts';
import type { MaaCommandOutput } from '../services/maaProcessService.ts';
import { testAdbConnection, discoverAdbDevices } from '../services/maaDeviceService.ts';
import { getMaaConfigDir, getConfig, saveConfig } from '../services/maaConfigService.ts';
import { getCurrentActivity } from '../services/maaActivityService.ts';
import { getScheduleExecutionStatus, getScheduleStatus, setupSchedule, stopSchedule, setupAutoUpdate, getAutoUpdateStatus } from '../services/schedulerService.ts';
import { getMaaResourceInfo, updateMaaResources } from '../services/resourceUpdateService.ts';
import { parseDepotData, parseOperBoxData } from '../services/dataParserService.ts';
import { loadParadoxOperators, resolveStageSearchKeyword } from '../services/copilotService.ts';
import { buildCopilotPlan, resetCopilotPlanProgress } from '../services/copilotPlanService.ts';
import { getActivityRunPreflight } from '../services/activityNavigationService.ts';
import { findActivityCopilotCandidates } from '../services/activityCopilotDiscoveryService.ts';
import { getActivityCompletion } from '../services/activityCopilotRunService.ts';
import { withMaaExecutionLease } from '../services/executionCoordinatorService.ts';
import { createOutboundHttpClient } from '../services/outboundRequestService.ts';
import {
  asyncHandler,
  agentError,
  sendSuccess,
  sendDryRun,
  sendError
} from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import { createLogger } from '../utils/logger.ts'
import { DEFAULT_MAA_CLI_PATH } from '../config/connectionDefaults.ts'
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
  parseUpdateCoreBody,
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

/**
 * 维护与平台入口路由：连接/profile 配置、连接诊断、资源与 MAA 更新、
 * 定时与自动更新配置、识别动作，以及更新日志/作业/活动查询。
 *
 * 这里只做 HTTP 适配。profile 读写复用 maaConfigService 的既有解析与覆盖
 * 策略；资源/核心/CLI 更新复用 resourceUpdateService、maaExecutionService
 * 与执行租约；
 * 定时与自动更新只调用 schedulerService 的注册入口，不自行持有定时器或
 * 执行状态；识别动作调用 dataParserService 的既有用例。router 不缓存运行
 * 状态、不另建子进程或锁。
 *
 * 维护写入与实际执行是不同操作：`/actions/configure-auto-update` 与
 * `POST /schedules` 只注册配置，执行仍走执行路由；带 `dryRun` 的维护
 * 动作只返回计划，不发起真实更新。出站查询（更新日志、作业、悖论）统一
 * 经出站端口，显式时限、取消与受限重试由端口承担。
 *
 * 请求与上游的未知值在 maintenanceDto 按端点收窄（profile 保存体、dryRun、
 * 更新渠道、定时注册、自动更新配置与查询参数各按既有规则）；响应载荷复用
 * 领域服务的公开结果，错误继续经统一错误出口返回。
 */
const router = Router();
const execFileAsync = promisify(execFile);
const logger = createLogger('AgentRoutes');

// 出站读取入口（changelog/copilot/paradox 查询）统一经出站端口：
// 显式时限、取消与受限重试由端口承担，错误经 asyncHandler 进入统一错误出口。
const outboundHttp = createOutboundHttpClient();

// 连接与 profile：读写仍由 maaConfigService 的 profile 解析与原子写入承担。
router.get('/config/maa/:profileName', asyncHandler<MaintenanceProfileRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await getConfig(req.params.profileName));
}));

router.post('/config/maa/:profileName', asyncHandler<MaintenanceProfileRequest, ApiResponseWriter>(async (req, res) => {
  await saveConfig(req.params.profileName, parseMaaProfileBody(req.body));
  return sendSuccess(res, req, null, '配置保存成功');
}));

// 活动查询：当前活动与预检读取 MAA/活动导航的既有入口，不缓存在 router。
router.get('/activity', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
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
    completion,
    available: !!activityInfo.code,
    message: activityInfo.code ? `当前活动: ${activityInfo.name || activityInfo.code}` : '当前没有活动或无法获取活动信息'
  };
  return sendSuccess(res, req, payload);
}));

router.get('/activity/preflight', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
  const { clientType } = await resolveMaintenanceConnection(req);
  const preflight = await getActivityRunPreflight(clientType);
  return sendSuccess(res, req, preflight, preflight.reason);
}));

router.get('/activity/copilot-candidates', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
  const { clientType } = await resolveMaintenanceConnection(req);
  const candidates = await findActivityCopilotCandidates(clientType);
  return sendSuccess(res, req, candidates, candidates.reason);
}));

// 识别动作：解析 MAA 日志并更新本地缓存，属于有副作用的维护动作，
// 与只读的游戏数据路由分开；dryRun 只返回计划。
router.post('/actions/depot-recognition', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
  const plan: MaintenanceRecognitionPlan = {
    action: 'depot-recognition',
    sideEffects: ['parse_maa_logs', 'update_local_depot_cache']
  };
  if (parseDryRunBody(req.body).dryRun) {
    return sendDryRun(res, req, plan);
  }
  return sendSuccess(res, req, await parseDepotData(), '仓库识别完成');
}));

router.post('/actions/operbox-recognition', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
  const plan: MaintenanceRecognitionPlan = {
    action: 'operbox-recognition',
    sideEffects: ['parse_maa_logs', 'update_local_operbox_cache']
  };
  if (parseDryRunBody(req.body).dryRun) {
    return sendDryRun(res, req, plan);
  }
  return sendSuccess(res, req, await parseOperBoxData(), '干员识别完成');
}));

// 更新日志与作业查询：只读上游，不写本地状态。
router.get('/changelog/core', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
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
}));

router.get('/changelog/cli', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
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
}));

router.get('/copilots/:id', asyncHandler<MaintenanceCopilotRequest, ApiResponseWriter>(async (req, res) => {
  const { data } = await outboundHttp.requestJson(`https://prts.maa.plus/copilot/get/${req.params.id}`);
  return sendSuccess(res, req, data);
}));

router.get('/copilot-sets/:id', asyncHandler<MaintenanceCopilotRequest, ApiResponseWriter>(async (req, res) => {
  const { data } = await outboundHttp.requestJson(`https://prts.maa.plus/set/get?id=${encodeURIComponent(req.params.id)}`);
  return sendSuccess(res, req, data);
}));

router.get('/copilot-sets/:id/plan', asyncHandler<MaintenanceCopilotRequest, ApiResponseWriter>(async (req, res) => {
  const { raid } = parseCopilotPlanQuery(req.query);
  return sendSuccess(res, req, await buildCopilotPlan(req.params.id, raid));
}));

router.post('/copilot-sets/:id/reset-progress', asyncHandler<MaintenanceCopilotRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await resetCopilotPlanProgress(req.params.id));
}));

router.get('/paradox/search', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
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
}));

router.get('/copilot/search', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
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
}));

router.get('/paradox/operators', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await loadParadoxOperators());
}));

// 定时与自动更新配置：只注册/查询 schedulerService 的触发源，
// 实际执行仍由执行路由与调度触发源承担，这里不启动任务。
router.get('/schedules/status', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, getScheduleStatus());
}));

router.get('/schedules/execution', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, getScheduleExecutionStatus());
}));

router.post('/schedules', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
  const { scheduleId, times, taskFlow } = parseScheduleSetupBody(req.body);
  const result = setupSchedule(scheduleId, times, taskFlow);
  if (!result.success) {
    return sendError(res, req, agentError('AGENT_SCHEDULE_SETUP_FAILED', result.message, { statusCode: 400 }));
  }
  return sendSuccess(res, req, result, result.message);
}));

router.delete('/schedules/:scheduleId', asyncHandler<MaintenanceScheduleStopRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, stopSchedule(req.params.scheduleId));
}));

router.post('/actions/configure-auto-update', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, setupAutoUpdate(parseAutoUpdateBody(req.body)));
}));

router.get('/auto-update/status', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, getAutoUpdateStatus());
}));

// 资源、核心与 CLI 维护：进程副作用经既有 maaExecutionService/
// resourceUpdateService 与执行租约，dryRun 只返回计划。
router.post('/actions/open-config-directory', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
  const configDir = await getMaaConfigDir();
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'explorer.exe'
      : 'xdg-open';
  await execFileAsync(command, [configDir]);
  const payload: MaintenanceOpenConfigDirectoryPayload = { configDir };
  return sendSuccess(res, req, payload, '配置目录已打开');
}));

router.post('/actions/update-core', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
  const { version, dryRun } = parseUpdateCoreBody(req.body);
  const corePlan: MaintenanceUpdatePlanStep = version === 'beta'
    ? { action: 'update-core', targetChannel: 'beta', command: 'install', args: ['beta', '--force'] }
    : version === 'stable'
      ? { action: 'update-core', targetChannel: 'stable', command: 'install', args: ['stable', '--force'] }
      : { action: 'update-core', targetChannel: 'current', command: 'update', args: [] };
  const plan: MaintenanceUpdateCorePlan = {
    action: 'update-core-and-resources',
    steps: [corePlan, { action: 'hot-update-resources', script: 'server/scripts/update-maa-resources.ts' }]
  };

  if (dryRun) return sendDryRun(res, req, plan);

  return withMaaExecutionLease({ source: 'core-update', taskName: '更新 MaaCore 与资源', command: 'update' }, async () => {
    let coreResult: MaaCommandOutput;
    try {
      coreResult = version === 'beta'
        ? await execMaaCommand('install', ['beta', '--force'])
        : version === 'stable'
          ? await execMaaCommand('install', ['stable', '--force'])
          : await execMaaCommand('update', []);
    } catch (error) {
      logger.error('更新 MaaCore 失败', { error: thrownMessage(error), version });
      return sendError(res, req, agentError('AGENT_MAA_UPDATE_CORE_FAILED', `MaaCore 更新失败: ${thrownMessage(error)}`, {
        statusCode: 500,
        retryable: true,
        details: { version, failedStep: 'core', coreUpdated: false }
      }));
    }

    try {
      const resourceResult = await updateMaaResources();
      const runtime = await getMaaVersion(true);
      const payload: MaintenanceUpdateCorePayload = {
        plan,
        steps: {
          core: { success: true, output: coreResult.stdout || coreResult.stderr || '' },
          resources: { success: true, output: resourceResult.output }
        },
        runtime: { ...runtime, resource: resourceResult.resource }
      };
      return sendSuccess(res, req, payload, version ? `已切换到 ${String(version)} 渠道并同步最新资源` : 'MaaCore 和资源已更新');
    } catch (error) {
      const runtime = await getMaaVersion(true).catch(() => null);
      const resource = await getMaaResourceInfo().catch(() => null);
      logger.error('MaaCore 已更新，但资源同步失败', { error: thrownMessage(error), version });
      return sendError(res, req, agentError('AGENT_MAA_UPDATE_RESOURCE_FAILED', `MaaCore 已更新，但资源同步失败: ${thrownMessage(error)}`, {
        statusCode: 500,
        retryable: true,
        details: {
          version,
          failedStep: 'resources',
          coreUpdated: true,
          runtime: runtime ? { ...runtime, resource } : null
        }
      }));
    }
  });
}));

router.post('/actions/update-cli', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const os = await import('os');
  const execAsync = promisify(exec);
  const MAA_CLI_PATH = DEFAULT_MAA_CLI_PATH;
  const isDocker = process.env.NODE_ENV === 'production' && await execAsync('test -f /.dockerenv').then(() => true).catch(() => false);
  const command = isDocker ? `${MAA_CLI_PATH} self update` : (os.platform() === 'darwin' ? 'brew upgrade maa-cli' : `${MAA_CLI_PATH} self update`);
  const plan: MaintenanceUpdateCliPlan = { action: 'update-cli', command };
  if (parseDryRunBody(req.body).dryRun) return sendDryRun(res, req, plan);
  return withMaaExecutionLease({ source: 'cli-update', taskName: '更新 MAA CLI', command: 'update-cli' }, async () => {
    const { stdout, stderr } = await execAsync(command);
    const payload: MaintenanceUpdateCliPayload = { output: stdout || stderr, plan };
    return sendSuccess(res, req, payload, `MAA CLI 更新完成${isDocker ? '（Docker 环境）' : ''}`);
  });
}));

router.post('/actions/hot-update-resources', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
  const plan: MaintenanceHotUpdateResourcesPlan = { action: 'hot-update-resources', script: 'server/scripts/update-maa-resources.ts' };
  if (parseDryRunBody(req.body).dryRun) return sendDryRun(res, req, plan);
  try {
    const result = await updateMaaResources();
    const payload: MaintenanceHotUpdateResourcesPayload = { ...result, plan };
    return sendSuccess(res, req, payload, '资源文件更新成功');
  } catch (error) {
    return sendError(res, req, agentError('AGENT_MAA_RESOURCE_UPDATE_FAILED', `资源同步失败: ${thrownMessage(error)}`, {
      statusCode: 500,
      retryable: true,
      details: { failedStep: 'resources' }
    }));
  }
}));

// 连接诊断与平台信息：连接覆盖沿用请求级解析，设备探测复用 maaDeviceService。
router.post('/actions/test-connection', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
  const { adbPath, address } = await resolveMaintenanceConnection(req)
  return sendSuccess(res, req, await testAdbConnection(adbPath, address));
}));

router.get('/actions/discover-devices', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
  const { adbPath } = await resolveMaintenanceConnection(req)
  return sendSuccess(res, req, await discoverAdbDevices(adbPath));
}));

router.get('/version', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
  const [version, resource] = await Promise.all([
    getMaaVersion(true),
    getMaaResourceInfo().catch(resourceInfoFallback)
  ]);
  const payload: MaintenanceVersionPayload = { ...version, resource };
  return sendSuccess(res, req, payload);
}));

router.get('/config-directory', asyncHandler<MaintenanceRequest, ApiResponseWriter>(async (req, res) => {
  const payload: MaintenanceConfigDirectoryPayload = { path: await getMaaConfigDir() };
  return sendSuccess(res, req, payload);
}));

export default router;
