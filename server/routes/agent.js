import express from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  execMaaCommand,
  getMaaVersion,
  testAdbConnection,
  discoverAdbDevices,
  captureScreen,
  getMaaConfigDir,
  getConfig,
  saveConfig,
  getCurrentActivity
} from '../services/maaService.js';
import { getScheduleExecutionStatus, getScheduleStatus, setupSchedule, stopSchedule, setupAutoUpdate, getAutoUpdateStatus } from '../services/schedulerService.js';
import { saveUserConfig } from '../services/configStorageService.ts';
import { sendConfigStorageError } from './userConfig.ts';
import agentExecutionRoutes from './agentExecution.js';
import agentStatusRoutes from './agentStatusRoutes.js';
import agentLogRoutes from './agentLogRoutes.js';
import agentDataRoutes from './agentDataRoutes.js';
import { getAndroidDisplayState, getWebrtcSummary } from './deviceStatus.js';
import { getNotificationConfig, sendNotification, sendToChannel, testNotificationChannel, setNotificationConfig } from '../services/notificationService.js';
import operatorTrainingService from '../services/operatorTrainingService.js';
import { getMaaResourceInfo, updateMaaResources } from '../services/resourceUpdateService.js';
import { parseDepotData, parseOperBoxData } from '../services/dataParserService.js';
import { loadParadoxOperators, resolveStageSearchKeyword } from '../services/copilotService.js';
import { resetCopilotPlanProgress } from '../services/copilotPlanService.js';
import { getActivityRunPreflight } from '../services/activityNavigationService.js';
import { findActivityCopilotCandidates } from '../services/activityCopilotDiscoveryService.js';
import { getActivityCompletion } from '../services/activityCopilotRunService.js';
import { withMaaExecutionLease } from '../services/executionCoordinatorService.js';
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
import { WEBRTC_SIGNALING_PATH } from '../services/webrtcSignalingGateway.js'
import { DEFAULT_ADB_ADDRESS, DEFAULT_ADB_PATH, DEFAULT_CLIENT_TYPE, DEFAULT_MAA_CLI_PATH } from '../config/connectionDefaults.js'
import { buildAgentManifest, buildOpenApiSpec } from './agentContract.js';
import {
  installWebrtc,
  startWebrtcServer,
  stopWebrtcServer,
  startWebrtcAgent,
  stopWebrtcAgent,
  startWebrtc,
  stopWebrtc,
  getWebrtcDevices,
  DEFAULT_DEVICE_ID
} from '../services/webrtcService.js';

const router = express.Router();
const execFileAsync = promisify(execFile);
const logger = createLogger('AgentRoutes');

// 出站读取入口（changelog/copilot/paradox 查询）统一经出站端口：
// 显式时限、取消与受限重试由端口承担，错误经 asyncHandler 进入统一错误出口。
const outboundHttp = createOutboundHttpClient();

export function buildWebrtcBrowserProtocol(deviceId) {
  return {
    websocket: `${WEBRTC_SIGNALING_PATH}/connect_client?token=`,
    connectMessage: { message_type: 'connect', device_id: deviceId },
    requestOfferPayload: { type: 'request-offer', ip_preference: 'ipv4' },
    candidatePolicy: 'relay preferred / ipv4'
  };
}

function pngDimensions(base64) {
  try {
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length >= 24 && buffer.toString('ascii', 12, 16) === 'IHDR') {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
  } catch {
    // best-effort metadata only
  }
  return { width: null, height: null };
}

function buildOrientationPlan({ orientation, adbPath = DEFAULT_ADB_PATH, address = DEFAULT_ADB_ADDRESS } = {}) {
  const normalized = String(orientation || '').trim().toLowerCase();
  const rotationByOrientation = { portrait: '0', landscape: '1' };

  if (!['portrait', 'landscape', 'auto'].includes(normalized)) {
    throw agentError('AGENT_VALIDATION_ORIENTATION_INVALID', 'orientation 必须是 portrait、landscape 或 auto', {
      statusCode: 400,
      details: { orientation },
      retryable: false
    });
  }

  const commands = normalized === 'auto'
    ? [
        ['settings', 'put', 'system', 'accelerometer_rotation', '1']
      ]
    : [
        ['settings', 'put', 'system', 'accelerometer_rotation', '0'],
        ['settings', 'put', 'system', 'user_rotation', rotationByOrientation[normalized]],
        ['cmd', 'window', 'set-user-rotation', 'lock', rotationByOrientation[normalized]]
      ];

  return {
    action: 'preview-orientation',
    orientation: normalized,
    adbPath,
    address,
    commands: commands.map(args => ({ command: adbPath, args: ['-s', address, 'shell', ...args] }))
  };
}

async function setAndroidOrientation(options = {}) {
  const plan = buildOrientationPlan(options);
  const results = [];

  for (const item of plan.commands) {
    try {
      const { stdout, stderr } = await execFileAsync(item.command, item.args, { timeout: 7000, maxBuffer: 256 * 1024 });
      results.push({ ok: true, args: item.args, stdout: stdout.trim(), stderr: stderr.trim() });
    } catch (error) {
      const optionalCmdWindow = item.args.includes('cmd') && item.args.includes('window') && item.args.includes('set-user-rotation');
      results.push({ ok: optionalCmdWindow, optional: optionalCmdWindow, args: item.args, error: error.message, stdout: (error.stdout || '').trim(), stderr: (error.stderr || '').trim() });
      if (!optionalCmdWindow) throw error;
    }
  }

  await new Promise(resolve => setTimeout(resolve, 500));
  return {
    ...plan,
    results,
    observed: await getAndroidDisplayState(plan.adbPath, plan.address)
  };
}

router.get('/manifest', (req, res) => {
  return sendSuccess(res, req, buildAgentManifest({
    adbPath: DEFAULT_ADB_PATH,
    adbAddress: DEFAULT_ADB_ADDRESS,
    clientType: DEFAULT_CLIENT_TYPE
  }));
});

router.get('/openapi.json', (req, res) => {
  res.json(buildOpenApiSpec({
    adbPath: DEFAULT_ADB_PATH,
    adbAddress: DEFAULT_ADB_ADDRESS,
    clientType: DEFAULT_CLIENT_TYPE
  }));
});

// 状态汇总与 Run 查询由独立 router 承担；状态探测保留在状态边界内，
// 不与执行编排或纯数据读取混在一起。
router.use(agentStatusRoutes);

router.post('/screen/screenshot', asyncHandler(async (req, res) => {
  const { adbPath, address, profileId } = await resolveRequestConnection(req, { allowOverrides: true })
  const screenshot = await captureScreen(adbPath, address);
  return sendSuccess(res, req, {
    ...screenshot,
    ...pngDimensions(screenshot.image),
    mediaType: 'image/png',
    adbPath,
    address,
    profileId
  });
}));

// 日志读取与清理由独立 router 承担；清空/清理仍属运行数据维护，
// 不能因迁出 agent.js 而当作无副作用接口。
router.use(agentLogRoutes);

router.get('/config/maa/:profileName', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, await getConfig(req.params.profileName));
}));

router.post('/config/maa/:profileName', asyncHandler(async (req, res) => {
  await saveConfig(req.params.profileName, req.body || {});
  return sendSuccess(res, req, null, '配置保存成功');
}));

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

// 执行路由与 Run 生命周期适配由独立 router 承担；此处按原注册顺序挂载，
// agent.js 只保留领域 router 聚合、配置与维护入口。
router.use(agentExecutionRoutes);

// 今日关卡、掉落与本地游戏数据读取由独立 router 承担；识别动作仍留在
// 动作入口，读取路由不解析 MAA 日志或更新缓存。
router.use(agentDataRoutes);

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

router.get('/training/operators', asyncHandler(async (req, res) => {
  const filters = {
    rarity: req.query.rarity ? parseInt(req.query.rarity) : undefined,
    profession: req.query.profession,
    owned: req.query.owned === 'true' ? true : req.query.owned === 'false' ? false : undefined,
    needsElite2: req.query.needsElite2 === 'true',
    status: req.query.status || 'trainable'
  };
  const operators = await operatorTrainingService.getOperatorList(filters);
  return sendSuccess(res, req, { operators, count: operators.length });
}));

router.get('/training/queue', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, await operatorTrainingService.getTrainingQueue());
}));

router.post('/training/queue', asyncHandler(async (req, res) => {
  const { operatorId, currentElite, targetElite, position } = req.body || {};
  if (!operatorId) {
    return sendError(res, req, agentError('AGENT_VALIDATION_OPERATOR_ID_REQUIRED', '缺少 operatorId 参数', { statusCode: 400 }));
  }
  const queueItem = await operatorTrainingService.addToQueue(operatorId, { currentElite, targetElite, position });
  return sendSuccess(res, req, queueItem, '已添加到养成队列');
}));

router.delete('/training/queue/:operatorId', asyncHandler(async (req, res) => {
  const result = await operatorTrainingService.removeFromQueue(req.params.operatorId);
  return sendSuccess(res, req, result, '已从养成队列中移除');
}));

router.put('/training/queue/order', asyncHandler(async (req, res) => {
  const { operatorIds } = req.body || {};
  if (!Array.isArray(operatorIds)) {
    return sendError(res, req, agentError('AGENT_VALIDATION_OPERATOR_IDS_REQUIRED', 'operatorIds 必须是数组', { statusCode: 400 }));
  }
  const result = await operatorTrainingService.updateQueueOrder(operatorIds);
  return sendSuccess(res, req, result, '队列顺序已更新');
}));

router.post('/training/sync', asyncHandler(async (req, res) => {
  const result = await operatorTrainingService.syncTrainingFlow();
  return sendSuccess(res, req, result, result.flowSync.status === 'failed' ? '任务流程同步失败，可重试' : '任务流程同步状态已更新');
}));

router.put('/training/settings', asyncHandler(async (req, res) => {
  const settings = await operatorTrainingService.updateSettings(req.body || {});
  return sendSuccess(res, req, settings, '设置已更新');
}));

router.post('/training/plan', asyncHandler(async (req, res) => {
  const plan = await operatorTrainingService.generateTrainingPlan(req.body?.mode || 'current');
  return sendSuccess(res, req, plan);
}));

router.post('/actions/apply-training-plan', asyncHandler(async (req, res) => {
  const { plan, settings } = req.body || {};
  if (!plan) {
    return sendError(res, req, agentError('AGENT_VALIDATION_PLAN_REQUIRED', '缺少 plan 参数', { statusCode: 400 }));
  }
  const result = await operatorTrainingService.applyPlanToTasks(plan, settings);
  return sendSuccess(res, req, result, '养成计划已应用到任务流程');
}));

router.post('/actions/fetch-training-materials', asyncHandler(async (req, res) => {
  const plan = { action: 'fetch-training-materials', sideEffects: ['refresh_training_material_cache'] };
  if (req.body?.dryRun) {
    return sendDryRun(res, req, plan);
  }
  const result = await operatorTrainingService.fetchOperatorMaterials();
  return sendSuccess(res, req, result, '养成材料数据已更新');
}));

router.get('/webrtc/status', asyncHandler(async (req, res) => {
  const { address, adbPath, profileId } = await resolveRequestConnection(req, { allowOverrides: true })
  const summary = await getWebrtcSummary(address, adbPath);
  return sendSuccess(res, req, { ...summary, profileId, devices: await getWebrtcDevices() });
}));

router.get('/webrtc/devices', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, { devices: await getWebrtcDevices() });
}));

router.post('/webrtc/start', asyncHandler(async (req, res) => {
  const { address, adbPath, profileId } = await resolveRequestConnection(req, { allowOverrides: true })
  const deviceId = req.body?.deviceId || DEFAULT_DEVICE_ID;
  const status = await startWebrtc(address, deviceId, adbPath);
  const summary = await getWebrtcSummary(address, adbPath);
  return sendSuccess(res, req, {
    ...summary,
    ...status,
    devices: await getWebrtcDevices(),
    deviceId,
    address,
    profileId,
    protocol: buildWebrtcBrowserProtocol(deviceId)
  });
}));

router.post('/webrtc/stop', asyncHandler(async (req, res) => {
  const { address, adbPath } = await resolveRequestConnection(req, { allowOverrides: true })
  return sendSuccess(res, req, await stopWebrtc(address, adbPath));
}));

router.post('/preview/orientation', asyncHandler(async (req, res) => {
  const { orientation, dryRun = false } = req.body || {};
  const { adbPath, address } = await resolveRequestConnection(req, { allowOverrides: true })
  const plan = buildOrientationPlan({ orientation, adbPath, address });

  if (dryRun) {
    return sendDryRun(res, req, plan);
  }

  return sendSuccess(res, req, await setAndroidOrientation({ orientation, adbPath, address }), '屏幕方向已设置');
}));

router.post('/webrtc/install', asyncHandler(async (req, res) => {
  const result = await installWebrtc();
  return sendSuccess(res, req, result, 'WebRTC 组件已安装');
}));

router.post('/webrtc/start-server', asyncHandler(async (req, res) => {
  const { address, adbPath } = await resolveRequestConnection(req, { allowOverrides: true })
  const result = await startWebrtcServer(address, adbPath);
  return sendSuccess(res, req, result, 'WebRTC 服务已启动');
}));

router.post('/webrtc/stop-server', asyncHandler(async (req, res) => {
  const { address, adbPath } = await resolveRequestConnection(req, { allowOverrides: true })
  const result = await stopWebrtcServer(address, adbPath);
  return sendSuccess(res, req, result, 'WebRTC 服务已停止');
}));

router.post('/webrtc/start-agent', asyncHandler(async (req, res) => {
  const { address, adbPath } = await resolveRequestConnection(req, { allowOverrides: true })
  const deviceId = req.body?.deviceId || DEFAULT_DEVICE_ID;
  const result = await startWebrtcAgent(address, deviceId, adbPath);
  return sendSuccess(res, req, result, 'MuMu Agent 已启动');
}));

router.post('/webrtc/stop-agent', asyncHandler(async (req, res) => {
  const { address, adbPath } = await resolveRequestConnection(req, { allowOverrides: true })
  const result = await stopWebrtcAgent(address, adbPath);
  return sendSuccess(res, req, result, 'MuMu Agent 已停止');
}));

async function getDeviceStats(adbPath, address) {
  try {
    const cmd = (c) => execFileAsync(adbPath, ['-s', address, 'shell', c], { timeout: 5000, maxBuffer: 256 * 1024 })
    const [loadRaw, memRaw, diskRaw, tempRaw, topRaw] = await Promise.all([
      cmd('cat /proc/loadavg'),
      cmd('cat /proc/meminfo | head -4'),
      cmd('df -h /data | tail -1'),
      cmd('dumpsys battery | grep temperature'),
      cmd('top -b -n 1 -d 0.3 | head -5'),
    ])

    // CPU load from /proc/loadavg
    const loadParts = loadRaw.stdout.trim().split(/\s+/)
    // CPU usage % from top output: "400%cpu  0%user ... 396%idle"
    const topTotal = topRaw.stdout.match(/(\d+)%cpu/i)
    const topIdle  = topRaw.stdout.match(/(\d+)%idle/i)
    const cpuPct = topTotal && topIdle ? Math.round(((parseInt(topTotal[1]) - parseInt(topIdle[1])) / parseInt(topTotal[1])) * 100) : null
    // Memory from /proc/meminfo (kB)
    const memInfo = {};
    for (const line of memRaw.stdout.split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) memInfo[m[1]] = parseInt(m[2]);
    }
    const memTotalKb = memInfo['MemTotal'] || 0;
    const memFreeKb  = memInfo['MemFree'] || 0;
    const memAvailKb = memInfo['MemAvailable'] || 0;
    const memUsedKb  = memTotalKb - (memAvailKb || memFreeKb);
    const swapTotalKb = memInfo['SwapTotal'] || 0;
    const swapUsedKb  = swapTotalKb - (memInfo['SwapFree'] || 0);
    const diskParts = diskRaw.stdout.trim().split(/\s+/)
    const tempMatch = tempRaw.stdout.match(/temperature:\s*(\d+)/)

    const fmtMb = (kb) => kb >= 1048576 ? `${(kb / 1048576).toFixed(1)}G` : kb >= 1024 ? `${Math.round(kb / 1024)}M` : `${kb}K`

    return {
      load1m: loadParts[0] ? parseFloat(loadParts[0]) : null,
      load5m: loadParts[1] ? parseFloat(loadParts[1]) : null,
      load15m: loadParts[2] ? parseFloat(loadParts[2]) : null,
      cpuPct,
      memTotalKb, memUsedKb, memFreeKb: memAvailKb || memFreeKb,
      memTotal: fmtMb(memTotalKb),
      memUsed:  fmtMb(memUsedKb),
      memFree:  fmtMb(memAvailKb || memFreeKb),
      memPct: memTotalKb ? Math.round((memUsedKb / memTotalKb) * 100) : null,
      swapTotalKb,
      swapUsedKb,
      diskTotal: diskParts[1] || null,
      diskUsed:  diskParts[2] || null,
      diskFree:  diskParts[3] || null,
      diskPct:   diskParts[4] ? parseInt(diskParts[4]) : null,
      temp: tempMatch ? parseInt(tempMatch[1]) / 10 : null,
    }
  } catch { return null }
}

router.get('/device-stats', asyncHandler(async (req, res) => {
  const { adbPath, address } = await resolveRequestConnection(req, { allowOverrides: true })
  const stats = await getDeviceStats(adbPath, address);
  return sendSuccess(res, req, stats);
}));

router.get('/notifications/config', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, getNotificationConfig());
}));

router.post('/notifications/config', asyncHandler(async (req, res) => {
  const result = await saveUserConfig('notification', req.body || {});
  if (!result.success) {
    return sendConfigStorageError(res, req, result, 'AGENT_NOTIFICATION_CONFIG_SAVE_FAILED', '通知配置保存失败');
  }
  setNotificationConfig(req.body || {});
  return sendSuccess(res, req, null, '通知配置已保存');
}));

router.post('/actions/test-notification-channel', asyncHandler(async (req, res) => {
  const channel = req.body?.channel;
  const config = req.body?.config;
  if (!channel) {
    return sendError(res, req, agentError('AGENT_VALIDATION_CHANNEL_REQUIRED', '缺少通知渠道', { statusCode: 400 }));
  }
  if (config != null && (typeof config !== 'object' || Array.isArray(config))) {
    return sendError(res, req, agentError('AGENT_VALIDATION_NOTIFICATION_CONFIG_INVALID', '通知渠道配置格式无效', { statusCode: 400 }));
  }
  const result = await testNotificationChannel(channel, config || null);
  if (!result.success) {
    return sendError(res, req, agentError('AGENT_NOTIFICATION_TEST_FAILED', result.message || '测试通知失败', { statusCode: 400, details: { channel } }));
  }
  return sendSuccess(res, req, { channel }, result.message || '测试消息已发送');
}));

router.post('/actions/send-notification', asyncHandler(async (req, res) => {
  const { channel, title, content, level = 'info', data } = req.body || {};
  const payload = { title: title || '测试通知', content: content || '这是一条测试通知', level, data };
  const result = channel ? await sendToChannel(channel, payload) : await sendNotification(payload);
  return sendSuccess(res, req, result, channel ? '通知已发送到指定渠道' : '通知已发送');
}));

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

export { executeTrackedAgentAction } from './agentExecution.js';

export default router;
