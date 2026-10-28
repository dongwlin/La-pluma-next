import { mkdir, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { execMaaCommand, execDynamicTask } from './maaExecutionService.js';
import { getMaaConfigDir } from './maaConfigService.js';
import { createMaaLogCheckpoint, readMaaLogSince } from './maaLogFileService.js';
import { withMaaExecutionLease } from './executionCoordinatorService.js';
import { recordDrops } from './dropRecordService.js';
import { createOutboundHttpClient } from './outboundRequestService.ts';
import { createCopilotProgressStore } from './copilotProgressStore.js';
import { updateJsonFile, writeJsonFile } from '../utils/fileHelper.ts';

const dataDir = fileURLToPath(new URL('../data/', import.meta.url));
// 作业进度是共享 JSON 状态：读改写经进度存储按路径排队执行；
// 默认位置保持 server/data/copilot-progress.json，可用环境变量注入隔离。
const progressStore = createCopilotProgressStore({
  progressPath: process.env.LA_PLUMA_COPILOT_PROGRESS_STORE || join(dataDir, 'copilot-progress.json')
});

// 作业站读取：服务内已有固定次数重试循环，端口侧关闭自动重试以保持总请求次数不变。
const outboundHttp = createOutboundHttpClient();

function parseCopilotContent(data) {
  try {
    return typeof data?.content === 'string' ? JSON.parse(data.content) : (data?.content || {});
  } catch {
    return {};
  }
}

async function fetchJson(url, maxAttempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const { data: payload } = await outboundHttp.requestJson(url, {
        timeoutMs: 15000,
        retry: { maxRetries: 0 }
      });
      if (payload.status_code && payload.status_code !== 200) throw new Error(payload.message || '作业站返回失败');
      return payload.data || payload;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
      }
    }
  }
  throw new Error(`作业站请求失败: ${lastError?.message || '网络异常'}`, { cause: lastError });
}

export function isPresetFormationCopilot(copilot = {}) {
  const stageName = String(copilot.stage_name || '');
  return (!Array.isArray(copilot.opers) || copilot.opers.length === 0) &&
    (!Array.isArray(copilot.groups) || copilot.groups.length === 0) &&
    /_s\d+$/i.test(stageName);
}

export function getNavigationStage(copilot = {}) {
  const title = String(copilot.doc?.title || '').trim();
  const code = title.match(/\b(?:[A-Z]{1,5}|\d{1,2})-(?:(?:EX|S|MO|TR)-)?\d+\b/i)?.[0];
  return code || title || String(copilot.stage_name || '');
}

async function loadStageCodeMap(stageIds) {
  try {
    const resourceDir = (await execMaaCommand('dir', ['resource'], null, null, false, true)).stdout.trim();
    const tileDir = join(resourceDir, 'Arknights-Tile-Pos');
    const filenames = await readdir(tileDir);
    const result = new Map();
    await Promise.all([...new Set(stageIds.filter(Boolean))].map(async stageId => {
      const filename = filenames.find(name =>
        name.endsWith('.json') && (name.startsWith(`${stageId}-`) || name.startsWith(`${stageId}#`))
      );
      if (!filename) return;
      try {
        const metadata = JSON.parse(await readFile(join(tileDir, filename), 'utf8'));
        if (metadata.code) result.set(stageId, { code: metadata.code, apCost: 0 });
      } catch {}
    }));
    try {
      const stages = JSON.parse(await readFile(join(resourceDir, 'stages.json'), 'utf8'));
      for (const stage of stages) {
        if (!stage?.stageId || !stage?.code) continue;
        const existing = result.get(stage.stageId);
        result.set(stage.stageId, {
          code: existing?.code || stage.code,
          apCost: Math.max(0, Number(stage.apCost) || 0)
        });
      }
    } catch {}
    const missingStageIds = [...new Set(stageIds.filter(stageId => stageId && !result.get(stageId)?.apCost))];
    if (missingStageIds.length > 0) {
      try {
        const penguinStages = await fetchJson('https://penguin-stats.io/PenguinStats/api/v2/stages?server=CN');
        for (const stage of penguinStages) {
          if (!missingStageIds.includes(stage?.stageId) || !stage?.code) continue;
          result.set(stage.stageId, {
            code: stage.code,
            apCost: Math.max(0, Number(stage.apCost) || 0)
          });
        }
      } catch {}
    }
    return result;
  } catch {
    return new Map();
  }
}

export async function buildCopilotPlan(setId, raid = 'normal') {
  const set = await fetchJson(`https://prts.maa.plus/set/get?id=${encodeURIComponent(setId)}`);
  const ids = Array.isArray(set.copilot_ids) ? set.copilot_ids : [];
  const copilotContents = [];
  for (const id of ids) {
    const data = await fetchJson(`https://prts.maa.plus/copilot/get/${id}`);
    copilotContents.push({ id, content: parseCopilotContent(data) });
  }
  const stageCodes = await loadStageCodeMap(copilotContents.map(item => item.content.stage_name));
  const copilots = copilotContents.map(({ id, content }) => {
    return {
      id: Number(id),
      stageId: content.stage_name || '',
      stage: stageCodes.get(content.stage_name)?.code || getNavigationStage(content) || `prts://${id}`,
      apCost: stageCodes.get(content.stage_name)?.apCost || 0,
      presetFormation: isPresetFormationCopilot(content),
      supportsRaid: !isPresetFormationCopilot(content),
      operators: content.opers || [],
      groups: content.groups || []
    };
  });

  const requestedModes = raid === 'both' ? ['normal', 'raid'] : [raid === 'raid' ? 'raid' : 'normal'];
  const entries = [];
  for (const [itemIndex, copilot] of copilots.entries()) {
    for (const mode of requestedModes) {
      if (mode === 'raid' && !copilot.supportsRaid) continue;
      entries.push({
        key: `${itemIndex}:${copilot.id}:${mode}`,
        itemIndex,
        copilotId: copilot.id,
        stageId: copilot.stageId,
        displayStage: copilot.stage,
        apCost: copilot.apCost,
        mode,
        presetFormation: copilot.presetFormation
      });
    }
  }
  const progress = await progressStore.load();
  const completed = new Set(progress[String(setId)] || []);
  return {
    setId: String(setId),
    name: set.name || `作业集 ${setId}`,
    items: copilots,
    entries: entries.map(entry => ({ ...entry, completed: completed.has(entry.key) }))
  };
}

export function mergePresetFormationTasks(installedTasks, userTasks = {}) {
  return {
    ...userTasks,
    LaPlumaPresetBattleConfirm: {
      algorithm: 'OcrDetect',
      text: ['开始战斗', '是否开始战斗'],
      roi: [700, 430, 560, 280],
      action: 'ClickSelf',
      postDelay: 2000,
      next: ['BattleOfficiallyBegin', 'SkipThePreBattlePlot', 'Stop']
    },
    BattleStart: {
      ...installedTasks.BattleStart,
      ...(userTasks.BattleStart || {}),
      next: ['BattleOfficiallyBegin', 'LaPlumaPresetBattleConfirm', 'SkipThePreBattlePlot', 'Stop']
    }
  };
}

export function buildCurrentMapStageTasks(stages = []) {
  return Object.fromEntries([...new Set(stages.map(stage => String(stage || '').trim().toUpperCase()).filter(Boolean))]
    .map(stage => [stage, { text: [stage] }]));
}

export async function ensureCurrentMapActivityResource(configDir, activityCode, stages) {
  const code = String(activityCode || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(code)) throw new Error('活动代号格式不合法');
  const tasks = buildCurrentMapStageTasks(stages);
  if (!Object.keys(tasks).length) throw new Error('没有可写入的活动关卡');
  const stageFile = join(configDir, 'resource', 'tasks', 'Stages', `${code}.json`);
  // 执行产物 JSON 经临时文件原子替换写入，中断不会留下半截关卡文件。
  await writeJsonFile(stageFile, tasks);
  return { stageFile, stages: Object.keys(tasks) };
}

async function ensurePresetFormationResource(configDir) {
  const installedResource = (await execMaaCommand('dir', ['resource'], null, null, false, true)).stdout.trim();
  const installedTasks = JSON.parse(await readFile(join(installedResource, 'tasks', 'tasks.json'), 'utf8'));
  const userTasksPath = join(configDir, 'resource', 'tasks', 'tasks.json');
  // 用户 tasks.json 与安装资源的合并是共享资源读改写：读取、合并、写回在同一
  // 排队单元内原子完成；缺失文件按空任务合并，损坏文件报错且不覆盖原内容。
  await updateJsonFile(userTasksPath, current => mergePresetFormationTasks(installedTasks, current), {});
}

export function buildCopilotTaskParams(list, presetFormation, options = {}) {
  return {
    copilot_list: list,
    formation: presetFormation ? false : options.formationMode !== 'off',
    ignore_requirements: options.ignoreRequirements !== false,
    use_sanity_potion: options.useSanityPotion === true,
    add_trust: options.addTrust === true,
    formation_index: Number(options.formationIndex || 0),
    support_unit_usage: Number(options.supportUsage || 0),
    support_unit_name: String(options.supportName || '')
  };
}

function normalizeCopilotLoopTimes(value) {
  return Math.max(1, Math.min(99, Number.parseInt(String(value || 1), 10) || 1));
}

export function extractLoadedCopilotFiles(logText = '') {
  // MAA writes `file_name` inside `details` before the trailing `what`
  // discriminator for a successfully loaded copilot entry.
  return [...String(logText).matchAll(/"file_name"\s*:\s*"([^"]+)"[\s\S]{0,500}?"what"\s*:\s*"CopilotListLoadTaskFileSuccess"/g)]
    .map(match => match[1]);
}

export function buildCopilotRepeatFiles(entry, loopTimes, planDir) {
  return Array.from({ length: normalizeCopilotLoopTimes(loopTimes) }, (_, index) => ({
    repeat: index + 1,
    filename: join(planDir, `${entry.itemIndex}-${entry.copilotId}-${entry.mode}-${index + 1}.json`)
  }));
}

async function prepareCopilotList(entries, { planDir, loopTimes }) {
  const list = [];
  const executionItems = [];
  for (const entry of entries) {
    const data = await fetchJson(`https://prts.maa.plus/copilot/get/${entry.copilotId}`);
    const content = parseCopilotContent(data);
    for (const { repeat, filename } of buildCopilotRepeatFiles(entry, loopTimes, planDir)) {
      await writeJsonFile(filename, content);
      list.push({
        id: executionItems.length,
        filename,
        stage_name: entry.displayStage,
        is_raid: entry.mode === 'raid'
      });
      executionItems.push({ entry, filename, repeat });
    }
  }
  return { list, executionItems };
}

/**
 * Classifies the entries of one MAA Copilot command after it exited. MAA
 * loads plan files in order, so entries fully before the last loaded file are
 * confirmed. A stop leaves the in-flight entry `stopped` and later entries
 * `pending`; a failure marks everything not confirmed as failed.
 */
export function classifyCopilotEntryOutcomes({ entries, executionItems, currentIndex, stopped, message }) {
  return entries.map(entry => {
    const indexes = executionItems
      .map((item, index) => (item.entry.key === entry.key ? index : -1))
      .filter(index => index >= 0);
    const confirmed = indexes.length > 0 && currentIndex > 0 && indexes.every(index => index < currentIndex);
    if (confirmed) return { entry, status: 'success' };
    if (!stopped) return { entry, status: 'failed', error: message };
    if (currentIndex >= 0 && indexes.some(index => index <= currentIndex)) {
      return { entry, status: 'stopped', error: message };
    }
    return { entry, status: 'pending' };
  });
}

function buildCopilotEntryOutcome({ entries, statusByKey, completed, results, loopTimes, stopped, error }) {
  const taskResults = entries.map(entry => {
    const settled = statusByKey.get(entry.key) || { status: 'pending' };
    return {
      key: entry.key,
      itemIndex: entry.itemIndex,
      copilotId: entry.copilotId,
      stageId: entry.stageId,
      stage: entry.displayStage,
      displayStage: entry.displayStage,
      apCost: entry.apCost,
      mode: entry.mode,
      presetFormation: Boolean(entry.presetFormation),
      status: settled.status,
      ...(settled.error ? { error: settled.error } : {})
    };
  });
  const count = status => taskResults.filter(result => result.status === status).length;
  const summary = {
    totalEntries: taskResults.length,
    successCount: count('success'),
    failedCount: count('failed'),
    stoppedCount: count('stopped'),
    pendingCount: count('pending'),
    taskResults
  };
  return {
    success: summary.failedCount === 0,
    stopped,
    error: error || null,
    results,
    completed: [...completed],
    pending: entries.filter(entry => !completed.has(entry.key)),
    loopTimes,
    summary
  };
}

async function runCopilotGroup({
  group,
  configDir,
  planDir,
  loopTimes,
  options,
  name,
  taskPrefix,
  lifecycle
}) {
  const checkpoint = await createMaaLogCheckpoint();
  let executionItems = [];
  try {
    const prepared = await prepareCopilotList(group.entries, { planDir, loopTimes });
    executionItems = prepared.executionItems;
    if (!prepared.list.length) {
      return { statuses: group.entries.map(entry => ({ entry, status: 'success' })), error: null, stopped: false };
    }

    lifecycle.onEntryStarted?.(group.entries[0], group.entries);
    const taskId = `${taskPrefix}_${Date.now()}`;
    const taskConfig = {
      name: taskId,
      type: 'Copilot',
      params: buildCopilotTaskParams(prepared.list, group.presetFormation, options)
    };
    if (group.presetFormation) await ensurePresetFormationResource(configDir);
    await execDynamicTask(taskId, taskConfig, `作业集 ${name}`, 'copilot', true, group.presetFormation || options.userResource === true);
    return { statuses: group.entries.map(entry => ({ entry, status: 'success' })), error: null, stopped: false };
  } catch (error) {
    const logText = await readMaaLogSince(checkpoint).catch(() => '');
    const loadedFiles = extractLoadedCopilotFiles(logText);
    const currentFile = loadedFiles.at(-1) || '';
    const currentIndex = executionItems.findIndex(item => currentFile === item.filename || currentFile.endsWith(item.filename));
    const wasStopped = Boolean(error?.stopped) || Boolean(await lifecycle.shouldStop?.());
    const statuses = classifyCopilotEntryOutcomes({
      entries: group.entries,
      executionItems,
      currentIndex,
      stopped: wasStopped,
      message: error.message || '作业集执行失败'
    });
    return {
      statuses,
      error: wasStopped ? null : error,
      stopped: wasStopped
    };
  }
}

/**
 * Executes selected copilot entries as one set attempt. The caller owns the
 * Run; this function acquires the device lease, reports per-entry status
 * through the lifecycle hooks and stops between groups when asked. Failures
 * are returned as data so callers can decide whether the set failed.
 */
export async function executeCopilotEntries({
  setId,
  name,
  entries = [],
  options = {},
  lifecycle = {},
  taskPrefix = `copilot_plan_${setId}`
}) {
  const normalizedEntries = entries.filter(entry => Number.isInteger(Number(entry.copilotId)) && entry.displayStage);
  const loopTimes = normalizeCopilotLoopTimes(options.loopTimes);
  const progress = await progressStore.load();
  const completed = new Set(progress[String(setId)] || []);
  const statusByKey = new Map(normalizedEntries.map(entry => [entry.key, { status: 'pending' }]));
  const results = [];
  let stopped = false;
  let failure = null;

  if (normalizedEntries.length === 0) {
    return buildCopilotEntryOutcome({
      entries: normalizedEntries,
      statusByKey,
      completed,
      results,
      loopTimes,
      stopped: false,
      error: null
    });
  }

  await withMaaExecutionLease({
    source: 'copilot-set',
    taskName: name,
    command: 'copilot-plan'
  }, async () => {
    await lifecycle.onBeforeStart?.();
    lifecycle.onStarted?.();
    const configDir = (await getMaaConfigDir()).trim();
    const planDir = join(configDir, 'copilot-plans', String(setId));
    await mkdir(planDir, { recursive: true });

    for (const group of groupEntries(normalizedEntries)) {
      if (await lifecycle.shouldStop?.()) {
        stopped = true;
        break;
      }

      const groupOutcome = await runCopilotGroup({
        group,
        configDir,
        planDir,
        loopTimes,
        options,
        name,
        taskPrefix,
        lifecycle
      });
      groupOutcome.statuses.forEach(settled => {
        statusByKey.set(settled.entry.key, { status: settled.status, error: settled.error });
        lifecycle.onEntrySettled?.(settled.entry, settled.status, settled.error);
        if (settled.status === 'success') {
          completed.add(settled.entry.key);
          results.push({ ...settled.entry, success: true });
        } else if (settled.status !== 'pending') {
          results.push({
            ...settled.entry,
            success: false,
            error: settled.error,
            ...(settled.status === 'stopped' ? { stopped: true } : {})
          });
        }
      });
      const successfulEntries = groupOutcome.statuses
        .filter(settled => settled.status === 'success')
        .map(settled => settled.entry);
      try {
        await recordCompletedCopilotEntries(successfulEntries, loopTimes);
        // 读改写当前文件内容后仅替换本作业集的键，其他作业集的进度不受影响。
        await progressStore.update(current => ({ ...current, [String(setId)]: [...completed] }));
      } catch (error) {
        failure = error;
        break;
      }

      if (groupOutcome.stopped) {
        stopped = true;
        break;
      }
      if (groupOutcome.error) {
        failure = groupOutcome.error;
        break;
      }
    }
  });

  return buildCopilotEntryOutcome({
    entries: normalizedEntries,
    statusByKey,
    completed,
    results,
    loopTimes,
    stopped,
    error: failure
  });
}

async function recordCompletedCopilotEntries(entries, loopTimes) {
  for (const entry of entries) {
    await recordDrops({
      stage: entry.displayStage,
      times: loopTimes,
      sanity: entry.apCost * loopTimes,
      medicine: 0,
      stone: 0,
      items: [],
      source: 'copilot',
      mode: entry.mode
    });
  }
}

function groupEntries(entries) {
  const groups = [];
  for (const entry of entries) {
    const previous = groups[groups.length - 1];
    if (previous && previous.presetFormation === entry.presetFormation) previous.entries.push(entry);
    else groups.push({ presetFormation: entry.presetFormation, entries: [entry] });
  }
  return groups;
}

/**
 * Runs an already-selected list of copilot ids through the same dynamic MAA
 * Copilot task used by copilot sets. Callers must decide selection separately.
 */
export async function executeSelectedCopilotEntries({ planId, name, entries, options = {}, lifecycle = {} }) {
  const normalizedEntries = entries.filter(entry => Number.isInteger(Number(entry.copilotId)) && entry.displayStage);
  if (!normalizedEntries.length) throw new Error('没有可执行的作业条目');

  const results = [];
  const loopTimes = normalizeCopilotLoopTimes(options.loopTimes);
  await withMaaExecutionLease({ source: 'activity-copilot', taskName: name, command: 'copilot-plan' }, async () => {
    await lifecycle.onBeforeStart?.();
    lifecycle.onStarted?.();
    const configDir = (await getMaaConfigDir()).trim();
    const planDir = join(configDir, 'copilot-plans', String(planId));
    await mkdir(planDir, { recursive: true });

    for (const [groupIndex, group] of groupEntries(normalizedEntries).entries()) {
      const { list } = await prepareCopilotList(group.entries, { planDir, loopTimes });
      if (!list.length) continue;

      const taskId = `activity_copilot_${planId}_${groupIndex}`;
      const taskConfig = {
        name: taskId,
        type: 'Copilot',
        params: buildCopilotTaskParams(list, group.presetFormation, options)
      };
      if (group.presetFormation) await ensurePresetFormationResource(configDir);
      await execDynamicTask(taskId, taskConfig, name, 'copilot', true, group.presetFormation || options.userResource === true);
      results.push(...group.entries.map(entry => ({ ...entry, success: true })));
    }
  });

  return { success: true, results, loopTimes };
}

export async function executeCopilotPlan({ setId, raid = 'normal', selectedIndexes = [], options = {}, lifecycle = {} }) {
  const plan = await buildCopilotPlan(setId, raid);
  const selected = new Set(selectedIndexes.map(Number));
  const selectedEntries = plan.entries.filter(entry => selected.size === 0 || selected.has(entry.itemIndex));
  const progress = await progressStore.load();
  const completed = new Set(progress[String(setId)] || []);
  const pending = selectedEntries.filter(entry => !completed.has(entry.key));

  const outcome = await executeCopilotEntries({
    setId,
    name: plan.name,
    entries: pending,
    options,
    lifecycle,
    taskPrefix: `copilot_plan_${setId}`
  });

  if (outcome.error && !outcome.stopped) {
    const message = outcome.error.message || '作业集执行失败';
    const error = new Error(message, { cause: outcome.error });
    error.code = outcome.error.code || 'COPILOT_PLAN_FAILED';
    error.statusCode = outcome.error.statusCode || 422;
    error.details = {
      ...(outcome.error.details || {}),
      plan,
      results: outcome.results,
      completed: outcome.completed,
      summary: outcome.summary,
      stopped: false
    };
    error.retryable = true;
    throw Object.assign(error, { copilotPlan: { plan, results: outcome.results, completed: outcome.completed } });
  }

  const result = {
    success: true,
    stopped: outcome.stopped,
    plan,
    results: outcome.results,
    completed: outcome.completed,
    pending: selectedEntries.filter(entry => !outcome.completed.includes(entry.key)),
    loopTimes: outcome.loopTimes,
    summary: outcome.summary
  };
  if (outcome.stopped) return { ...result, message: '作业集已被终止' };
  return result;
}

export async function resetCopilotPlanProgress(setId) {
  // 读改写删除单键：并发保存其他作业集进度的更新不会丢失，损坏文件报错且不清零。
  await progressStore.update(current => {
    const next = { ...current };
    delete next[String(setId)];
    return next;
  });
  return { success: true };
}
