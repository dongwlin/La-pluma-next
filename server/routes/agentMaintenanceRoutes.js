import express from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { execMaaCommand, getMaaVersion } from '../services/maaExecutionService.ts';
import { testAdbConnection, discoverAdbDevices } from '../services/maaDeviceService.ts';
import { getMaaConfigDir, getConfig, saveConfig } from '../services/maaConfigService.ts';
import { getCurrentActivity } from '../services/maaActivityService.ts';
import { getScheduleExecutionStatus, getScheduleStatus, setupSchedule, stopSchedule, setupAutoUpdate, getAutoUpdateStatus } from '../services/schedulerService.js';
import { getMaaResourceInfo, updateMaaResources } from '../services/resourceUpdateService.js';
import { parseDepotData, parseOperBoxData } from '../services/dataParserService.ts';
import { loadParadoxOperators, resolveStageSearchKeyword } from '../services/copilotService.ts';
import { buildCopilotPlan, resetCopilotPlanProgress } from '../services/copilotPlanService.js';
import { getActivityRunPreflight } from '../services/activityNavigationService.js';
import { findActivityCopilotCandidates } from '../services/activityCopilotDiscoveryService.js';
import { getActivityCompletion } from '../services/activityCopilotRunService.js';
import { withMaaExecutionLease } from '../services/executionCoordinatorService.ts';
import { createOutboundHttpClient } from '../services/outboundRequestService.ts';
import {
  asyncHandler,
  agentError,
  sendSuccess,
  sendDryRun,
  sendError
} from '../utils/apiHelper.ts';
import { createLogger } from '../utils/logger.ts'
import { resolveRequestConnection } from './requestConnection.js'
import { DEFAULT_MAA_CLI_PATH } from '../config/connectionDefaults.js'

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
 */
const router = express.Router();
const execFileAsync = promisify(execFile);
const logger = createLogger('AgentRoutes');

// 出站读取入口（changelog/copilot/paradox 查询）统一经出站端口：
// 显式时限、取消与受限重试由端口承担，错误经 asyncHandler 进入统一错误出口。
const outboundHttp = createOutboundHttpClient();

// 连接与 profile：读写仍由 maaConfigService 的 profile 解析与原子写入承担。
router.get('/config/maa/:profileName', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, await getConfig(req.params.profileName));
}));

router.post('/config/maa/:profileName', asyncHandler(async (req, res) => {
  await saveConfig(req.params.profileName, req.body || {});
  return sendSuccess(res, req, null, '配置保存成功');
}));

// 活动查询：当前活动与预检读取 MAA/活动导航的既有入口，不缓存在 router。
router.get('/activity', asyncHandler(async (req, res) => {
  const { clientType } = await resolveRequestConnection(req, { allowOverrides: true });
  const activityInfo = await getCurrentActivity(clientType);
  const completion = await getActivityCompletion(activityInfo);
  return sendSuccess(res, req, {
    code: activityInfo.code,
    name: activityInfo.name,
    source: activityInfo.source || null,
    startTime: activityInfo.startTime || null,
    endTime: activityInfo.endTime || null,
    stages: activityInfo.stages || [],
    completion,
    available: !!activityInfo.code,
    message: activityInfo.code ? `当前活动: ${activityInfo.name || activityInfo.code}` : '当前没有活动或无法获取活动信息'
  });
}));

router.get('/activity/preflight', asyncHandler(async (req, res) => {
  const { clientType } = await resolveRequestConnection(req, { allowOverrides: true });
  const preflight = await getActivityRunPreflight(clientType);
  return sendSuccess(res, req, preflight, preflight.reason);
}));

router.get('/activity/copilot-candidates', asyncHandler(async (req, res) => {
  const { clientType } = await resolveRequestConnection(req, { allowOverrides: true });
  const candidates = await findActivityCopilotCandidates(clientType);
  return sendSuccess(res, req, candidates, candidates.reason);
}));

// 识别动作：解析 MAA 日志并更新本地缓存，属于有副作用的维护动作，
// 与只读的游戏数据路由分开；dryRun 只返回计划。
router.post('/actions/depot-recognition', asyncHandler(async (req, res) => {
  const plan = {
    action: 'depot-recognition',
    sideEffects: ['parse_maa_logs', 'update_local_depot_cache']
  };
  if (req.body?.dryRun) {
    return sendDryRun(res, req, plan);
  }
  return sendSuccess(res, req, await parseDepotData(), '仓库识别完成');
}));

router.post('/actions/operbox-recognition', asyncHandler(async (req, res) => {
  const plan = {
    action: 'operbox-recognition',
    sideEffects: ['parse_maa_logs', 'update_local_operbox_cache']
  };
  if (req.body?.dryRun) {
    return sendDryRun(res, req, plan);
  }
  return sendSuccess(res, req, await parseOperBoxData(), '干员识别完成');
}));

// 更新日志与作业查询：只读上游，不写本地状态。
router.get('/changelog/core', asyncHandler(async (req, res) => {
  try {
    const { data: releases } = await outboundHttp.requestJson(
      `https://api.github.com/repos/MaaAssistantArknights/MaaAssistantArknights/releases?per_page=100`,
      {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'MAA-WebUI'
        }
      }
    );

    const latestBeta = releases.find(release => release.prerelease);
    const latestStable = releases.find(release => !release.prerelease);

    const changelog = [];

    if (latestBeta) {
      changelog.push({
        version: latestBeta.tag_name,
        name: latestBeta.name,
        body: latestBeta.body,
        publishedAt: latestBeta.published_at,
        htmlUrl: latestBeta.html_url,
        prerelease: latestBeta.prerelease
      });
    }

    if (latestStable) {
      changelog.push({
        version: latestStable.tag_name,
        name: latestStable.name,
        body: latestStable.body,
        publishedAt: latestStable.published_at,
        htmlUrl: latestStable.html_url,
        prerelease: latestStable.prerelease
      });
    }

    return sendSuccess(res, req, changelog);
  } catch (error) {
    return sendError(res, req, agentError('AGENT_CHANGELOG_CORE_FETCH_FAILED', `获取 MaaCore 更新日志失败: ${error.message}`, {
      statusCode: 502,
      details: { provider: 'github', target: 'MaaAssistantArknights' },
      retryable: true
    }));
  }
}));

router.get('/changelog/cli', asyncHandler(async (req, res) => {
  try {
    const { data: releases } = await outboundHttp.requestJson(
      `https://api.github.com/repos/MaaAssistantArknights/maa-cli/releases?per_page=100`,
      {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'MAA-WebUI'
        }
      }
    );
    const latestStable = releases.find(release => !release.prerelease);

    const changelog = latestStable ? [{
      version: latestStable.tag_name,
      name: latestStable.name,
      body: latestStable.body,
      publishedAt: latestStable.published_at,
      htmlUrl: latestStable.html_url,
      prerelease: latestStable.prerelease
    }] : [];

    return sendSuccess(res, req, changelog);
  } catch (error) {
    return sendError(res, req, agentError('AGENT_CHANGELOG_CLI_FETCH_FAILED', `获取 MAA CLI 更新日志失败: ${error.message}`, {
      statusCode: 502,
      details: { provider: 'github', target: 'maa-cli' },
      retryable: true
    }));
  }
}));

router.get('/copilots/:id', asyncHandler(async (req, res) => {
  const { data } = await outboundHttp.requestJson(`https://prts.maa.plus/copilot/get/${req.params.id}`);
  return sendSuccess(res, req, data);
}));

router.get('/copilot-sets/:id', asyncHandler(async (req, res) => {
  const { data } = await outboundHttp.requestJson(`https://prts.maa.plus/set/get?id=${encodeURIComponent(req.params.id)}`);
  return sendSuccess(res, req, data);
}));

router.get('/copilot-sets/:id/plan', asyncHandler(async (req, res) => {
  const raid = ['normal', 'raid', 'both'].includes(req.query.raid) ? req.query.raid : 'normal';
  return sendSuccess(res, req, await buildCopilotPlan(req.params.id, raid));
}));

router.post('/copilot-sets/:id/reset-progress', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, await resetCopilotPlanProgress(req.params.id));
}));

router.get('/paradox/search', asyncHandler(async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) {
    return sendError(res, req, agentError('AGENT_VALIDATION_OPERATOR_NAME_REQUIRED', '请提供干员名字', { statusCode: 400 }));
  }

  const paradoxData = await loadParadoxOperators();
  const operator = paradoxData.find(op => op.name.includes(name) || name.includes(op.name));
  if (!operator) {
    return sendError(res, req, agentError('AGENT_PARADOX_OPERATOR_NOT_FOUND', `未找到干员"${name}"的悖论模拟关卡`, { statusCode: 404, details: { name } }));
  }

  const { data } = await outboundHttp.requestJson(`https://prts.maa.plus/copilot/query?level_keyword=${operator.stage_id}&page=1&limit=10&order_by=hot`);
  if (data.status_code !== 200 || !data.data?.data?.length) {
    return sendError(res, req, agentError('AGENT_PARADOX_COPILOT_NOT_FOUND', `未找到干员"${operator.name}"的作业`, { statusCode: 404, details: { operator: operator.name, stageId: operator.stage_id } }));
  }

  const copilots = data.data.data.map(item => {
    let title = item.doc?.title || '无标题';
    try {
      const content = JSON.parse(item.content || '{}');
      title = content.doc?.title || title;
    } catch {}
    return {
      id: item.id,
      uri: `prts://${item.id}`,
      views: item.views,
      hotScore: item.hot_score,
      uploader: item.uploader_id,
      title
    };
  });

  return sendSuccess(res, req, {
    operator: operator.name,
    stageId: operator.stage_id,
    copilots,
    recommended: copilots[0]
  });
}));

router.get('/copilot/search', asyncHandler(async (req, res) => {
  const stage = String(req.query.stage || '').trim();
  if (!stage) {
    return sendError(res, req, agentError('AGENT_VALIDATION_STAGE_REQUIRED', '请提供关卡名称', { statusCode: 400 }));
  }

  const normalizedStage = stage.toUpperCase();
  const searchKeyword = await resolveStageSearchKeyword(stage);
  const allCopilots = [];
  let page = 1;
  const maxPages = 5;
  const targetCount = 10;

  while (page <= maxPages && allCopilots.length < targetCount) {
    const { data } = await outboundHttp.requestJson(`https://prts.maa.plus/copilot/query?level_keyword=${encodeURIComponent(searchKeyword)}&page=${page}&limit=50&order_by=hot`);
    if (data.status_code !== 200 || !data.data?.data?.length) break;

    for (const item of data.data.data) {
      let title = '无标题';
      let stageName = stage;
      let titleStageCode = '';
      try {
        const content = JSON.parse(item.content);
        title = content.doc?.title || '无标题';
        stageName = content.stage_name || stage;
        const titleMatch = title.match(/^([A-Z]{2,4}-\d+[A-Z]?)/i);
        if (titleMatch) titleStageCode = titleMatch[1].toUpperCase();
      } catch {}

      const normalizedStageName = String(stageName || '').trim().toUpperCase();
      const normalizedSearchKeyword = String(searchKeyword || '').trim().toUpperCase();
      if (normalizedStageName === normalizedStage || normalizedStageName === normalizedSearchKeyword || titleStageCode === normalizedStage) {
        allCopilots.push({
          id: item.id,
          uri: `prts://${item.id}`,
          views: item.views,
          hotScore: item.hot_score,
          uploader: item.uploader_id,
          title,
          stageName
        });
      }
    }

    if (!data.data.has_next) break;
    page += 1;
  }

  if (!allCopilots.length) {
    return sendError(res, req, agentError('AGENT_COPILOT_NOT_FOUND', `未找到关卡"${stage}"的作业`, { statusCode: 404, details: { stage, searchKeyword } }));
  }

  return sendSuccess(res, req, {
    stage,
    copilots: allCopilots.slice(0, targetCount),
    recommended: allCopilots[0]
  });
}));

router.get('/paradox/operators', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, await loadParadoxOperators());
}));

// 定时与自动更新配置：只注册/查询 schedulerService 的触发源，
// 实际执行仍由执行路由与调度触发源承担，这里不启动任务。
router.get('/schedules/status', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, getScheduleStatus());
}));

router.get('/schedules/execution', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, getScheduleExecutionStatus());
}));

router.post('/schedules', asyncHandler(async (req, res) => {
  const { scheduleId = 'default', times, taskFlow } = req.body || {};
  const result = setupSchedule(scheduleId, times, taskFlow);
  if (!result.success) {
    return sendError(res, req, agentError('AGENT_SCHEDULE_SETUP_FAILED', result.message, { statusCode: 400 }));
  }
  return sendSuccess(res, req, result, result.message);
}));

router.delete('/schedules/:scheduleId', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, stopSchedule(req.params.scheduleId));
}));

router.post('/actions/configure-auto-update', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, setupAutoUpdate(req.body || {}));
}));

router.get('/auto-update/status', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, getAutoUpdateStatus());
}));

// 资源、核心与 CLI 维护：进程副作用经既有 maaExecutionService/
// resourceUpdateService 与执行租约，dryRun 只返回计划。
router.post('/actions/open-config-directory', asyncHandler(async (req, res) => {
  const configDir = await getMaaConfigDir();
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'explorer.exe'
      : 'xdg-open';
  await execFileAsync(command, [configDir]);
  return sendSuccess(res, req, { configDir }, '配置目录已打开');
}));

router.post('/actions/update-core', asyncHandler(async (req, res) => {
  const { version, dryRun = false } = req.body || {};
  const corePlan = version === 'beta'
    ? { action: 'update-core', targetChannel: 'beta', command: 'install', args: ['beta', '--force'] }
    : version === 'stable'
      ? { action: 'update-core', targetChannel: 'stable', command: 'install', args: ['stable', '--force'] }
      : { action: 'update-core', targetChannel: 'current', command: 'update', args: [] };
  const plan = {
    action: 'update-core-and-resources',
    steps: [corePlan, { action: 'hot-update-resources', script: 'server/scripts/update-maa-resources.js' }]
  };

  if (dryRun) return sendDryRun(res, req, plan);

  return withMaaExecutionLease({ source: 'core-update', taskName: '更新 MaaCore 与资源', command: 'update' }, async () => {
    let coreResult;
    try {
      coreResult = version === 'beta'
        ? await execMaaCommand('install', ['beta', '--force'])
        : version === 'stable'
          ? await execMaaCommand('install', ['stable', '--force'])
          : await execMaaCommand('update', []);
    } catch (error) {
      logger.error('更新 MaaCore 失败', { error: error.message, version });
      return sendError(res, req, agentError('AGENT_MAA_UPDATE_CORE_FAILED', `MaaCore 更新失败: ${error.message}`, {
        statusCode: 500,
        retryable: true,
        details: { version, failedStep: 'core', coreUpdated: false }
      }));
    }

    try {
      const resourceResult = await updateMaaResources();
      const runtime = await getMaaVersion(true);
      return sendSuccess(res, req, {
        plan,
        steps: {
          core: { success: true, output: coreResult.stdout || coreResult.stderr || '' },
          resources: { success: true, output: resourceResult.output }
        },
        runtime: { ...runtime, resource: resourceResult.resource }
      }, version ? `已切换到 ${version} 渠道并同步最新资源` : 'MaaCore 和资源已更新');
    } catch (error) {
      const runtime = await getMaaVersion(true).catch(() => null);
      const resource = await getMaaResourceInfo().catch(() => null);
      logger.error('MaaCore 已更新，但资源同步失败', { error: error.message, version });
      return sendError(res, req, agentError('AGENT_MAA_UPDATE_RESOURCE_FAILED', `MaaCore 已更新，但资源同步失败: ${error.message}`, {
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

router.post('/actions/update-cli', asyncHandler(async (req, res) => {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const os = await import('os');
  const execAsync = promisify(exec);
  const MAA_CLI_PATH = DEFAULT_MAA_CLI_PATH;
  const isDocker = process.env.NODE_ENV === 'production' && await execAsync('test -f /.dockerenv').then(() => true).catch(() => false);
  const command = isDocker ? `${MAA_CLI_PATH} self update` : (os.platform() === 'darwin' ? 'brew upgrade maa-cli' : `${MAA_CLI_PATH} self update`);
  const plan = { action: 'update-cli', command };
  if (req.body?.dryRun) return sendDryRun(res, req, plan);
  return withMaaExecutionLease({ source: 'cli-update', taskName: '更新 MAA CLI', command: 'update-cli' }, async () => {
    const { stdout, stderr } = await execAsync(command);
    return sendSuccess(res, req, { output: stdout || stderr, plan }, `MAA CLI 更新完成${isDocker ? '（Docker 环境）' : ''}`);
  });
}));

router.post('/actions/hot-update-resources', asyncHandler(async (req, res) => {
  const plan = { action: 'hot-update-resources', script: 'server/scripts/update-maa-resources.js' };
  if (req.body?.dryRun) return sendDryRun(res, req, plan);
  try {
    const result = await updateMaaResources();
    return sendSuccess(res, req, { ...result, plan }, '资源文件更新成功');
  } catch (error) {
    return sendError(res, req, agentError('AGENT_MAA_RESOURCE_UPDATE_FAILED', `资源同步失败: ${error.message}`, {
      statusCode: 500,
      retryable: true,
      details: { failedStep: 'resources' }
    }));
  }
}));

// 连接诊断与平台信息：连接覆盖沿用请求级解析，设备探测复用 maaDeviceService。
router.post('/actions/test-connection', asyncHandler(async (req, res) => {
  const { adbPath, address } = await resolveRequestConnection(req, { allowOverrides: true })
  return sendSuccess(res, req, await testAdbConnection(adbPath, address));
}));

router.get('/actions/discover-devices', asyncHandler(async (req, res) => {
  const { adbPath } = await resolveRequestConnection(req, { allowOverrides: true })
  return sendSuccess(res, req, await discoverAdbDevices(adbPath));
}));

router.get('/version', asyncHandler(async (req, res) => {
  const [version, resource] = await Promise.all([
    getMaaVersion(true),
    getMaaResourceInfo().catch(error => ({
      lastUpdated: null,
      modifiedAt: null,
      ageDays: null,
      status: 'unknown',
      message: `资源版本读取失败: ${error.message}`,
      activity: null,
      gacha: null
    }))
  ]);
  return sendSuccess(res, req, { ...version, resource });
}));

router.get('/config-directory', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, { path: await getMaaConfigDir() });
}));

export default router;
