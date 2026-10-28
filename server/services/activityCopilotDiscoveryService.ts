import { getActivityRunPreflight } from './activityNavigationService.ts';
import type { ActivityNavigationActivity, ActivityNavigationResult } from './activityNavigationService.ts';
import { createOutboundHttpClient } from './outboundRequestService.ts';
import { DEFAULT_CLIENT_TYPE } from '../config/connectionDefaults.ts';

/**
 * 活动作业候选发现：先用活动预检确认导航资源，再按关卡查询作业站候选。
 *
 * 作业站响应统一按 unknown 收窄；候选只用于人工选择，本模块不启动作业，
 * 也不写执行进度。当前地图兜底只影响发现结果里的 navigationMode，
 * 真正的执行计划仍由调用方构建。
 */

const PRTS_QUERY_URL = 'https://prts.maa.plus/copilot/query';
const PRTS_TIMEOUT_MS = 12000;
const MAX_STAGES = 12;
const CANDIDATES_PER_STAGE = 3;
const SET_CANDIDATE_LIMIT = 8;

// 作业站读取/查询统一经出站端口；显式时限 12 秒保持不变。
const outboundHttp = createOutboundHttpClient();

/** 活动作业候选：字段由作业站载荷收窄而来，供人工选择与执行计划使用。 */
export interface ActivityCopilotCandidate {
  id: number;
  uri: string;
  stage: string;
  title: string;
  stageName: string;
  presetFormation: boolean;
  uploader: string | null;
  uploadTime: string | null;
  ratingLevel: number;
  ratingRatio: number;
  hotScore: number;
  views: number;
}

/** 单个关卡的候选查询结果：query 为实际请求地址，读取失败时记录 error。 */
export interface ActivityCopilotStageResult {
  stage: string;
  query: string | null;
  candidates: ActivityCopilotCandidate[];
  error?: string;
}

/** 作业集候选：成员内容覆盖当前活动全部主关卡时才返回。 */
export interface ActivityCopilotSet {
  id: string;
  name: string;
  creator: string | null;
  updatedAt: string | null;
  stages: string[];
  source: 'prts-set-query';
}

/** 候选发现结果：preflight 保留导航判断，navigationMode 只在返回结果时出现。 */
export interface ActivityCopilotDiscoveryResult {
  execution: { mode: 'manual-selection-required'; executable: false };
  source: { provider: 'prts.maa.plus'; endpoint: '/copilot/query'; orderBy: 'hot' };
  ranking: string[];
  preflight: ActivityNavigationResult;
  state: 'blocked' | 'candidates-ready';
  reason: string;
  stages: ActivityCopilotStageResult[];
  matchingSet?: ActivityCopilotSet | null;
  navigationMode?: 'current-map-fallback' | 'home-navigation';
}

type DiscoveryBase = Pick<ActivityCopilotDiscoveryResult, 'execution' | 'source' | 'ranking' | 'preflight'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 只有结构化错误才暴露 message；其他抛出值不在这里编造文案。 */
function readMessage(error: unknown): string | undefined {
  return isRecord(error) && typeof error.message === 'string' ? error.message : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readDocTitle(content: unknown): unknown {
  return isRecord(content) && isRecord(content.doc) ? content.doc.title : undefined;
}

/** 作业内容可能是 JSON 字符串或已解析对象；无法解析时按空对象处理。 */
function parseContent(item: unknown): Record<string, unknown> {
  const content = isRecord(item) ? item.content : undefined;
  if (typeof content === 'string') {
    try {
      const parsed: unknown = JSON.parse(content);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(content) ? content : {};
}

function isPresetFormation(content: Record<string, unknown>): boolean {
  return (!Array.isArray(content.opers) || content.opers.length === 0) &&
    (!Array.isArray(content.groups) || content.groups.length === 0) &&
    /_s\d+$/i.test(String(content.stage_name || ''));
}

function stageTitleMatches(title: unknown, stage: string): boolean {
  return new RegExp(`^\\s*${escapeRegExp(stage)}(?:\\s|$|[-_:：,【（(])`, 'i').test(String(title || ''));
}

function findKnownStage(title: unknown, stages: readonly string[]): string | null {
  return stages.find(stage => stageTitleMatches(title, stage)) || null;
}

function activityStageTitleMatches(title: unknown, code: string): boolean {
  return new RegExp(`^\\s*${escapeRegExp(code)}-(?:\\d+|EX-\\d+|S-\\d+|MO-\\d+|TR-\\d+)(?:\\s|$|[-_:：,【（(])`, 'i')
    .test(String(title || ''));
}

/** 作业集成员必须全部属于当前活动且覆盖全部主关卡；额外 S/EX 关卡允许存在。 */
export function coversActivityStages(
  contents: readonly unknown[],
  activityCode: string,
  stages: readonly string[]
): boolean {
  const expected = new Set(stages);
  if (!contents.length || !expected.size) return false;
  if (contents.some(content => !activityStageTitleMatches(readDocTitle(content), activityCode))) return false;
  const actual = new Set(contents
    .map(content => findKnownStage(readDocTitle(content), stages))
    .filter((stage): stage is string => Boolean(stage)));
  return [...expected].every(stage => actual.has(stage));
}

async function fetchCopilotContent(id: string): Promise<Record<string, unknown>> {
  let lastError: unknown;
  // 服务内已有固定次数重试循环，端口侧关闭自动重试以保持总请求次数不变。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { data: payload } = await outboundHttp.requestJson(
        `https://prts.maa.plus/copilot/get/${encodeURIComponent(id)}`,
        { timeoutMs: PRTS_TIMEOUT_MS, retry: { maxRetries: 0 } }
      );
      const body = isRecord(payload) && payload.data ? payload.data : payload;
      return parseContent(body);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw new Error(`作业读取失败: ${readMessage(lastError) || '网络异常'}`);
}

async function findMatchingCopilotSet(
  activity: ActivityNavigationActivity,
  stages: readonly string[]
): Promise<ActivityCopilotSet | null> {
  const keyword = activity.name || activity.code;
  // POST 查询：端口对写入类方法不自动重放，行为与原实现一致。
  const { data: payload } = await outboundHttp.requestJson('https://prts.maa.plus/set/query', {
    method: 'POST',
    body: { keyword, page: 1, limit: 20 },
    timeoutMs: PRTS_TIMEOUT_MS
  });
  const body = isRecord(payload) ? payload : null;
  const payloadData = body && isRecord(body.data) ? body.data : null;
  const sets = body?.status_code === 200 && payloadData && Array.isArray(payloadData.data) ? payloadData.data : [];
  const matches: ActivityCopilotSet[] = [];
  const publicSets = sets.filter((item): item is Record<string, unknown> =>
    isRecord(item) && item.status === 'PUBLIC'
  );
  for (const set of publicSets.slice(0, SET_CANDIDATE_LIMIT)) {
    const ids = Array.isArray(set.copilot_ids) ? set.copilot_ids : [];
    if (ids.length < stages.length) continue;
    try {
      // The public service may reset a burst of simultaneous requests. Read a
      // set's small member list in order with retries so a valid complete set
      // is not accidentally discarded and replaced by individual copilots.
      const contents: Record<string, unknown>[] = [];
      for (const id of ids) contents.push(await fetchCopilotContent(String(id)));
      // A full set often includes optional S/EX stages in addition to the main
      // event stages returned by the activity feed. Accept those extras, but
      // never accept a set containing unrelated stages or missing a main stage.
      if (!coversActivityStages(contents, String(activity.code), stages)) continue;
      matches.push({
        id: String(set.id),
        name: readOptionalString(set.name) || `作业集 ${String(set.id)}`,
        creator: readOptionalString(set.creator) || null,
        updatedAt: readOptionalString(set.update_time) || readOptionalString(set.create_time),
        stages: contents
          .map(content => findKnownStage(readDocTitle(content), stages))
          .filter((stage): stage is string => Boolean(stage)),
        source: 'prts-set-query'
      });
    } catch {
      // An unavailable member makes this set unsuitable; individual candidates can still be used.
    }
  }
  return matches.sort((left, right) =>
    String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
  )[0] || null;
}

/** 按评分、上传时间、热度与浏览量排序，只保留标题精确匹配当前关卡的候选。 */
export function rankActivityCopilots(items: unknown, stage: string): ActivityCopilotCandidate[] {
  const list = Array.isArray(items) ? items : [];
  return list
    .map(item => {
      const record = isRecord(item) ? item : {};
      const content = parseContent(item);
      const contentDoc = isRecord(content.doc) ? content.doc : null;
      const itemDoc = isRecord(record.doc) ? record.doc : null;
      return {
        id: Number(record.id),
        uri: `prts://${String(record.id)}`,
        stage,
        title: String(contentDoc?.title || itemDoc?.title || '').trim(),
        stageName: String(content.stage_name || '').trim(),
        presetFormation: isPresetFormation(content),
        uploader: readOptionalString(record.uploader) || readOptionalString(record.uploader_id) || null,
        uploadTime: readOptionalString(record.upload_time) || null,
        ratingLevel: Number(record.rating_level) || 0,
        ratingRatio: Number(record.rating_ratio) || 0,
        hotScore: Number(record.hot_score) || 0,
        views: Number(record.views) || 0
      };
    })
    .filter(candidate => Number.isInteger(candidate.id) && candidate.id > 0 && stageTitleMatches(candidate.title, stage))
    .sort((left, right) =>
      right.ratingLevel - left.ratingLevel ||
      right.ratingRatio - left.ratingRatio ||
      String(right.uploadTime || '').localeCompare(String(left.uploadTime || '')) ||
      right.hotScore - left.hotScore ||
      right.views - left.views
    )
    .slice(0, CANDIDATES_PER_STAGE);
}

async function queryStageCandidates(stage: string): Promise<ActivityCopilotStageResult> {
  const url = `${PRTS_QUERY_URL}?level_keyword=${encodeURIComponent(stage)}&page=1&limit=50&order_by=hot`;
  const { data: payload } = await outboundHttp.requestJson(url, { timeoutMs: PRTS_TIMEOUT_MS });
  const body = isRecord(payload) ? payload : null;
  const payloadData = body && isRecord(body.data) ? body.data : null;
  const items = body?.status_code === 200 && payloadData && Array.isArray(payloadData.data)
    ? payloadData.data
    : [];
  const reliableItems = items.filter((item): item is Record<string, unknown> =>
    isRecord(item) && item.available !== false && item.status === 'PUBLIC' && item.not_enough_rating !== true
  );
  return {
    stage,
    query: url,
    candidates: rankActivityCopilots(reliableItems, stage)
  };
}

/** 当前地图兜底只接受「导航资源不可用」且活动代号与关卡列表明确的预检结果。 */
export function canUseCurrentMapFallback(preflight: unknown): boolean {
  if (!isRecord(preflight) || !isRecord(preflight.activity)) return false;
  const activity = preflight.activity;
  return preflight.state === 'blocked' &&
    preflight.reasonCode === 'navigation-resource-unavailable' &&
    Boolean(activity.code) &&
    Array.isArray(activity.stages) && activity.stages.length > 0;
}

/** 查询当前活动的作业候选；只返回发现结果，不启动作业或写入进度。 */
export async function findActivityCopilotCandidates(
  clientType: string = DEFAULT_CLIENT_TYPE,
  { allowCurrentMap = false }: { allowCurrentMap?: boolean } = {}
): Promise<ActivityCopilotDiscoveryResult> {
  const preflight = await getActivityRunPreflight(clientType);
  const base: DiscoveryBase = {
    execution: { mode: 'manual-selection-required', executable: false },
    source: { provider: 'prts.maa.plus', endpoint: '/copilot/query', orderBy: 'hot' },
    ranking: [
      '仅保留公开、可用且评分充足的作业',
      '评分等级和评分比例优先',
      '同等评分按上传时间、热度和浏览量排序'
    ],
    preflight
  };

  const currentMapFallback = allowCurrentMap && canUseCurrentMapFallback(preflight);
  if (preflight.state !== 'ready' && !currentMapFallback) {
    return {
      ...base,
      state: 'blocked',
      reason: preflight.reason,
      stages: []
    };
  }

  const activity = preflight.activity;
  const activityCode = String(activity.code);
  const stages = [...new Set((activity.stages || [])
    .map(stage => String(stage || '').trim().toUpperCase())
    .filter(stage => new RegExp(`^${escapeRegExp(activityCode)}-(?:\\d+|EX-\\d+|S-\\d+|MO-\\d+|TR-\\d+)$`, 'i').test(stage)))]
    .slice(0, MAX_STAGES);
  if (!stages.length) {
    return {
      ...base,
      state: 'blocked',
      reason: '当前活动未提供可精确匹配的关卡列表，未查询作业站。',
      stages: []
    };
  }

  const results = await Promise.all(stages.map(async (stage): Promise<ActivityCopilotStageResult> => {
    try {
      return await queryStageCandidates(stage);
    } catch (error) {
      return { stage, query: null, candidates: [], error: readMessage(error) };
    }
  }));
  let matchingSet: ActivityCopilotSet | null = null;
  try {
    matchingSet = await findMatchingCopilotSet(activity, stages);
  } catch {
    // Set discovery is an optimization only; exact per-stage candidates remain valid.
  }
  const candidateCount = results.reduce((count, result) => count + result.candidates.length, 0);
  return {
    ...base,
    state: candidateCount ? 'candidates-ready' : 'blocked',
    reason: candidateCount
      ? currentMapFallback
        ? '未找到主页自动导航资源。请先手动进入当前活动关卡地图；系统将仅尝试在该地图内识别并运行作业。'
        : '已按当前活动的明确关卡代号找到候选作业，请选择后再执行。'
      : '未找到满足可靠性条件的活动作业，未生成执行计划。',
    stages: results,
    matchingSet,
    navigationMode: currentMapFallback ? 'current-map-fallback' : 'home-navigation'
  };
}
