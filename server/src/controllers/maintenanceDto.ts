import type { ApiRequestLike } from '../utils/apiHelper.ts';
import { resolveBoundedInteger } from '../utils/numericQueryHelper.ts';
import type { ConnectionProfile } from '../services/connectionService.ts';
import type { MaaVersionInfo } from '../services/maaExecutionService.ts';
import type { MaaActivityEntry, MaaActivityFailure, MaaActivityStatus } from '../services/maaActivityService.ts';
import type { ResourceInfo, ResourceUpdateResult } from '../services/resourceUpdateService.ts';
import type { AutoUpdateConfig } from '../services/scheduleTriggerService.ts';
import type { CopilotStageIdentity } from '../services/copilotPlanService.ts';
import type { CopilotStageCatalogEntry } from '../services/copilotStageCatalogService.ts';
import { normalizeCopilotStageId } from '../services/copilotStageCatalogService.ts';
import { resolveCopilotMatch } from '../services/copilotMatchService.ts';
import type { CopilotMatchSummary, OwnedOperatorSnapshot } from '../services/copilotMatchService.ts';
import { parseWaitForCompletion } from './executionDto.ts';
import { resolveRequestConnection } from './requestConnection.ts';

/** 维护路由处理器的请求端口：query/body 保持 unknown，由本模块按端点收窄。 */
export interface MaintenanceRequest extends ApiRequestLike {
  body?: unknown;
  query?: unknown;
}

export interface MaintenanceProfileRequest extends MaintenanceRequest {
  params: { profileName: string };
}

export interface MaintenanceCopilotRequest extends MaintenanceRequest {
  params: { id: string };
}

export interface MaintenanceScheduleStopRequest extends MaintenanceRequest {
  params: { scheduleId: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 读取抛出对象的 message 字段：非对象、缺失或非字符串按旧实现的属性访问
 * 结果归一（非字符串按文本输出），用于保持既有错误文案。
 */
export function thrownMessage(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const message = (error as { message?: unknown }).message;
  if (message === undefined) return undefined;
  return typeof message === 'string' ? message : String(message);
}

export function resolveMaintenanceConnection(request: MaintenanceRequest): Promise<ConnectionProfile> {
  return resolveRequestConnection(request, { allowOverrides: true });
}

/**
 * profile 保存体：Express 5 未解析或缺失请求体按旧实现的 `|| {}` 归一为空对象；
 * 返回 unknown 是因为顶层形状与 connection/instance_options 的合并与字段校验
 * 仍由 maaConfigService 承担，这里不能先收窄成对象而改变非对象请求体的既有结果。
 */
export function parseMaaProfileBody(body: unknown): unknown {
  return body || {};
}

/** 只读 `dryRun` 的维护动作：识别、CLI 更新与资源热更新共用同一真值语义。 */
export interface MaintenanceDryRunInput {
  dryRun: boolean;
}

export function parseDryRunBody(body: unknown): MaintenanceDryRunInput {
  const source = isRecord(body) ? body : {};
  return { dryRun: Boolean(source.dryRun) };
}

/**
 * 核心更新请求：`version` 只参与与 `beta`/`stable` 的全等比较，其它值保持原样
 * 进入计划、错误详情与完成文案；`dryRun` 保持真值语义。
 */
export interface MaintenanceUpdateCoreInput {
  version: unknown;
  dryRun: boolean;
}

export function parseUpdateCoreBody(body: unknown): MaintenanceUpdateCoreInput {
  const source = isRecord(body) ? body : {};
  return { version: source.version, dryRun: Boolean(source.dryRun) };
}

/** CLI 更新请求：`channel` 缺省时由服务端使用已持久化的渠道。 */
export interface MaintenanceUpdateCliInput {
  channel: unknown;
  dryRun: boolean;
}

export function parseUpdateCliBody(body: unknown): MaintenanceUpdateCliInput {
  const source = isRecord(body) ? body : {};
  return { channel: source.channel, dryRun: Boolean(source.dryRun) };
}

/**
 * 更新动作的提交语义：缺省同步等待完成，`waitForCompletion=false` 在更新取得
 * 执行权后返回 202 与 runId。校验与执行入口共用同一错误码。
 */
export function parseUpdateWaitForCompletion(body: unknown, defaultValue = true): boolean {
  return parseWaitForCompletion(isRecord(body) ? body.waitForCompletion : undefined, defaultValue);
}

/** 渠道设置请求：scope/channel 的取值由更新渠道域校验，这里只做形状收窄。 */
export interface MaintenanceUpdateChannelInput {
  scope: unknown;
  channel: unknown;
}

export function parseUpdateChannelBody(body: unknown): MaintenanceUpdateChannelInput {
  const source = isRecord(body) ? body : {};
  return { scope: source.scope, channel: source.channel };
}

/** 定时注册请求：scheduleId 缺省为 `default`，流程与时间点仍由调度域校验。 */
export interface MaintenanceScheduleSetupInput {
  scheduleId: string;
  times: unknown;
  taskFlow: unknown;
}

export function parseScheduleSetupBody(body: unknown): MaintenanceScheduleSetupInput {
  const source = isRecord(body) ? body : {};
  const scheduleId = source.scheduleId;
  return {
    scheduleId: scheduleId === undefined
      ? 'default'
      : typeof scheduleId === 'string' ? scheduleId : String(scheduleId),
    times: source.times,
    taskFlow: source.taskFlow
  };
}

export type MaintenanceAutoUpdateConfig = AutoUpdateConfig;

/**
 * 自动更新配置：请求体整体透传给调度域，扩展字段与原始值都要保留（响应会回显
 * 同一份配置）。这里只在库边界把已判定的对象记录收窄成域类型；`enabled`/`time`
 * 的真值判定、cron 注册与关闭时的注册表清理仍由 schedulerService 承担。
 */
export function parseAutoUpdateBody(body: unknown): MaintenanceAutoUpdateConfig {
  return (isRecord(body) ? body : {}) as MaintenanceAutoUpdateConfig;
}

export interface MaintenanceParadoxSearchInput {
  name: string;
}

export function parseParadoxSearchQuery(query: unknown): MaintenanceParadoxSearchInput {
  const source = isRecord(query) ? query : {};
  return { name: String(source.name || '').trim() };
}

export type MaintenanceCopilotSearchOrder = 'hot' | 'latest' | 'views';

const COPILOT_SEARCH_ORDERS: readonly MaintenanceCopilotSearchOrder[] = ['hot', 'latest', 'views'];
const COPILOT_SEARCH_OPERATOR_LIMIT = 20;
const COPILOT_SEARCH_DEFAULT_LIMIT = 20;
const COPILOT_SEARCH_MAX_LIMIT = 50;

export interface MaintenanceCopilotSearchInput {
  document: string;
  stage: string;
  orderBy: MaintenanceCopilotSearchOrder;
  includeOperators: string[];
  excludeOperators: string[];
  page: number;
  limit: number;
}

function isCopilotSearchOrder(value: unknown): value is MaintenanceCopilotSearchOrder {
  return typeof value === 'string' && (COPILOT_SEARCH_ORDERS as readonly string[]).includes(value);
}

function readCopilotSearchText(value: unknown): string {
  const scalar = Array.isArray(value) ? value[0] : value;
  return scalar === undefined || scalar === null ? '' : String(scalar).trim();
}

function readCopilotSearchBoundedInteger(value: unknown, defaultValue: number, max: number): number {
  if (value === undefined || value === null || value === '') return defaultValue;
  return resolveBoundedInteger(value, { defaultValue, min: 1, max });
}

/**
 * 重复参数先合并成一个字符串再拆分：上游按单个逗号串区分包含与 `~` 排除项，
 * 分开传多个 operator 参数会让排除项失效。
 */
function readCopilotSearchOperators(value: unknown): { include: string[]; exclude: string[] } {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const merged = raw
    .filter(entry => entry !== undefined && entry !== null)
    .map(entry => String(entry))
    .join(',');
  const include = new Set<string>();
  const exclude = new Set<string>();
  for (const part of merged.split(',')) {
    const name = part.trim();
    if (!name) continue;
    const excluded = name.startsWith('~');
    const operator = (excluded ? name.slice(1) : name).trim();
    if (!operator) continue;
    const bucket = excluded ? exclude : include;
    if (bucket.size < COPILOT_SEARCH_OPERATOR_LIMIT) bucket.add(operator);
  }
  return { include: [...include], exclude: [...exclude] };
}

export function parseCopilotSearchQuery(query: unknown): MaintenanceCopilotSearchInput {
  const source = isRecord(query) ? query : {};
  const orderBy = typeof source.orderBy === 'string' ? source.orderBy.trim() : '';
  const operators = readCopilotSearchOperators(source.operator);
  return {
    document: readCopilotSearchText(source.document),
    stage: readCopilotSearchText(source.level) || readCopilotSearchText(source.stage),
    orderBy: isCopilotSearchOrder(orderBy) ? orderBy : 'hot',
    includeOperators: operators.include,
    excludeOperators: operators.exclude,
    page: readCopilotSearchBoundedInteger(source.page, 1, Number.MAX_SAFE_INTEGER),
    limit: readCopilotSearchBoundedInteger(source.limit, COPILOT_SEARCH_DEFAULT_LIMIT, COPILOT_SEARCH_MAX_LIMIT)
  };
}

export type MaintenanceCopilotRaid = 'normal' | 'raid' | 'both' | 'auto';

const COPILOT_RAID_MODES: readonly MaintenanceCopilotRaid[] = ['normal', 'raid', 'both', 'auto'];

function isCopilotRaid(value: unknown): value is MaintenanceCopilotRaid {
  return typeof value === 'string' && (COPILOT_RAID_MODES as readonly string[]).includes(value);
}

export interface MaintenanceCopilotPlanInput {
  raid: MaintenanceCopilotRaid;
}

export function parseCopilotPlanQuery(query: unknown): MaintenanceCopilotPlanInput {
  const source = isRecord(query) ? query : {};
  const raid = source.raid;
  return { raid: isCopilotRaid(raid) ? raid : 'normal' };
}

/** 资源信息读取失败时的既有兜底投影：状态按 `unknown` 处理，不能当成正常。 */
export { buildResourceInfoFallback as resourceInfoFallback } from '../services/resourceUpdateService.ts';

export interface MaintenanceActivityCompletion {
  known: boolean;
  complete: boolean;
  completedStages: string[];
  totalStages: number;
  source: string;
}

export interface MaintenanceActivityPayload {
  code: string | null;
  name: string | null;
  source: string | null;
  startTime: number | null;
  endTime: number | null;
  stages: string[];
  rerun: boolean;
  activities: MaaActivityEntry[];
  completion: MaintenanceActivityCompletion;
  available: boolean;
  message: string;
  status: MaaActivityStatus;
  clientType: string;
  lastSuccessAt: number | null;
  dataUpdatedAt: number | null;
  failure: MaaActivityFailure | null;
}

/** 识别动作的 dryRun 计划：只列出计划的副作用，不执行解析或缓存写入。 */
export interface MaintenanceRecognitionPlan {
  action: 'depot-recognition' | 'operbox-recognition';
  sideEffects: string[];
}

/** 更新日志条目：上游字段原样透传，本层不改写或补值。 */
export interface MaintenanceChangelogEntry {
  version: unknown;
  name: unknown;
  body: unknown;
  publishedAt: unknown;
  htmlUrl: unknown;
  prerelease: unknown;
}

export interface GithubReleaseRecord {
  tagName: unknown;
  name: unknown;
  body: unknown;
  publishedAt: unknown;
  htmlUrl: unknown;
  prerelease: unknown;
}

/**
 * GitHub releases 列表：非数组按上游响应异常抛出，由调用方映射既有
 * `AGENT_CHANGELOG_*_FETCH_FAILED` 502；非对象条目跳过。
 */
export function parseGithubReleaseList(value: unknown): GithubReleaseRecord[] {
  if (!Array.isArray(value)) {
    throw new TypeError('GitHub releases 响应不是数组');
  }
  return value.filter(isRecord).map(release => ({
    tagName: release.tag_name,
    name: release.name,
    body: release.body,
    publishedAt: release.published_at,
    htmlUrl: release.html_url,
    prerelease: release.prerelease
  }));
}

export function toChangelogEntry(release: GithubReleaseRecord): MaintenanceChangelogEntry {
  return {
    version: release.tagName,
    name: release.name,
    body: release.body,
    publishedAt: release.publishedAt,
    htmlUrl: release.htmlUrl,
    prerelease: release.prerelease
  };
}

/** PRTS 作业查询信封：`status_code` 原样保留，非数组列表按空列表处理（同旧 `.length` 判定）。 */
export interface PrtsCopilotQueryPayload {
  statusCode: unknown;
  items: Record<string, unknown>[];
  hasNext: boolean;
  total?: number;
}

export function parsePrtsCopilotQueryPayload(value: unknown): PrtsCopilotQueryPayload {
  if (!isRecord(value)) {
    throw new TypeError('PRTS 作业查询响应不是对象');
  }
  const body = isRecord(value.data) ? value.data : {};
  const total = body.total;
  return {
    statusCode: value.status_code,
    items: Array.isArray(body.data) ? body.data.filter(isRecord) : [],
    hasNext: Boolean(body.has_next),
    ...(typeof total === 'number' && Number.isFinite(total) ? { total } : {})
  };
}

export interface MaintenanceCopilotEntry {
  id: unknown;
  uri: string;
  views: unknown;
  hotScore: unknown;
  uploader: unknown;
  title: unknown;
}

export type MaintenanceCopilotRecommendedMode = 'normal' | 'raid' | 'both';

/** 单个干员的练度要求：字段名与客户端 `CopilotDetailOperator` 对齐。 */
export interface CopilotOperatorDetail {
  name: string;
  group?: string;
  elite?: number;
  level?: number;
  skillLevel?: number;
  module?: string;
}

export interface MaintenanceCopilotSearchEntry {
  id: unknown;
  uri: string;
  views: unknown;
  hotScore: unknown;
  title: unknown;
  stageName: unknown;
  stageId: string;
  stageCode: string;
  stageLabel: string;
  operators: string[];
  uploader?: string;
  uploadTime?: string;
  match?: CopilotMatchSummary;
  details?: string;
  operatorDetails?: CopilotOperatorDetail[];
  groupNames?: string[];
  recommendedMode?: MaintenanceCopilotRecommendedMode;
}

/**
 * 单作业代理载荷追加展示关卡投影：`stage` 为可读代号，`stageId` 为作业内容里的
 * 原始标识。解析结果为空时保持原载荷，旧字段与 `status_code` 不变。
 */
export function projectCopilotStage(
  payload: unknown,
  stage: CopilotStageIdentity
): unknown {
  if (!isRecord(payload)) return payload;
  return {
    ...payload,
    ...(stage.stage ? { stage: stage.stage } : {}),
    ...(stage.stageId ? { stageId: stage.stageId } : {})
  };
}

function copilotDocTitle(value: unknown): unknown {
  return isRecord(value) && isRecord(value.doc) ? value.doc.title : undefined;
}

/**
 * 上游 `content` 是 JSON 文本：解析成功时以文档标题覆盖初始标题，失败沿用
 * 初始值（与旧实现的 try/catch 一致）。
 */
function resolveCopilotTitle(initial: unknown, content: unknown, fallback: string): unknown {
  let title = initial || fallback;
  try {
    title = copilotDocTitle(JSON.parse(String(content || '{}'))) || title;
  } catch {
    // 非 JSON content：沿用初始标题
  }
  return title;
}

export function projectParadoxCopilot(item: Record<string, unknown>): MaintenanceCopilotEntry {
  return {
    id: item.id,
    uri: `prts://${String(item.id)}`,
    views: item.views,
    hotScore: item.hot_score,
    uploader: item.uploader_id,
    title: resolveCopilotTitle(copilotDocTitle(item), item.content, '无标题')
  };
}

const COPILOT_OPERATOR_LIMIT = 30;

interface CopilotContentFields {
  title: unknown;
  stageName: unknown;
  operators: string[];
  parsed: Record<string, unknown> | null;
}

function readCopilotContentFields(content: unknown): CopilotContentFields {
  try {
    const parsed: unknown = JSON.parse(String(content || '{}'));
    const operators = new Set<string>();
    if (isRecord(parsed) && Array.isArray(parsed.opers)) {
      for (const oper of parsed.opers) {
        if (operators.size >= COPILOT_OPERATOR_LIMIT) break;
        if (!isRecord(oper) || typeof oper.name !== 'string') continue;
        const name = oper.name.trim();
        if (name) operators.add(name);
      }
    }
    return {
      title: copilotDocTitle(parsed),
      stageName: isRecord(parsed) ? parsed.stage_name : undefined,
      operators: [...operators],
      parsed: isRecord(parsed) ? parsed : null
    };
  } catch {
    return { title: undefined, stageName: undefined, operators: [], parsed: null };
  }
}

function copilotUploaderName(uploader: unknown, uploaderId: unknown): string | undefined {
  if (typeof uploader === 'string' && uploader.trim()) return uploader;
  if (uploaderId === undefined || uploaderId === null) return undefined;
  return String(uploaderId);
}

function copilotRequirementNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `module` 在上游是数字占位（-1 表示未装备），保持与客户端 `asModule` 相同的字符串化。 */
function copilotRequirementModule(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function readCopilotOperatorDetail(value: unknown): CopilotOperatorDetail | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name) return null;
  const requirements = isRecord(value.requirements) ? value.requirements : {};
  const group = typeof value.group === 'string' && value.group.trim() ? value.group.trim() : undefined;
  const elite = copilotRequirementNumber(requirements.elite);
  const level = copilotRequirementNumber(requirements.level);
  const skillLevel = copilotRequirementNumber(requirements.skill_level);
  const module = copilotRequirementModule(requirements.module);
  return {
    name,
    ...(group === undefined ? {} : { group }),
    ...(elite === undefined ? {} : { elite }),
    ...(level === undefined ? {} : { level }),
    ...(skillLevel === undefined ? {} : { skillLevel }),
    ...(module === undefined ? {} : { module })
  };
}

/** 与 `operators` 同源、同上限：列表条目只带前 30 个干员的练度要求。 */
function readCopilotOperatorDetails(parsed: Record<string, unknown> | null): CopilotOperatorDetail[] {
  if (!parsed || !Array.isArray(parsed.opers)) return [];
  const details: CopilotOperatorDetail[] = [];
  const names = new Set<string>();
  for (const oper of parsed.opers) {
    if (details.length >= COPILOT_OPERATOR_LIMIT) break;
    const detail = readCopilotOperatorDetail(oper);
    if (!detail || names.has(detail.name)) continue;
    names.add(detail.name);
    details.push(detail);
  }
  return details;
}

function readCopilotGroupNames(parsed: Record<string, unknown> | null): string[] {
  if (!parsed || !Array.isArray(parsed.groups)) return [];
  const names: string[] = [];
  for (const group of parsed.groups) {
    if (!isRecord(group) || typeof group.name !== 'string') continue;
    const name = group.name.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function copilotRecommendedMode(value: unknown): MaintenanceCopilotRecommendedMode | undefined {
  if (value === 0 || value === 1) return 'normal';
  if (value === 2) return 'raid';
  if (value === 3) return 'both';
  return undefined;
}

function copilotDocDetails(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.doc)) return undefined;
  const details = value.doc.details;
  return typeof details === 'string' && details.trim() ? details : undefined;
}

export interface CopilotSearchProjectionOptions {
  stageId?: string;
  stageIndex?: ReadonlyMap<string, CopilotStageCatalogEntry>;
  ownedOperators?: ReadonlyMap<string, OwnedOperatorSnapshot>;
}

/**
 * 关卡作业条目：标题与关卡名来自 content 文档，content 不是 JSON 时沿用默认标题与请求关卡。
 * 同时投影预览所需的说明、干员练度与分组：上游查询已返回完整 content，列表阶段带上这些字段
 * 后，点开卡片无需再为同一份数据发起一次详情请求。
 */
export function projectCopilotSearchItem(
  item: Record<string, unknown>,
  options: CopilotSearchProjectionOptions = {}
): MaintenanceCopilotSearchEntry {
  const content = readCopilotContentFields(item.content);
  const stageName = content.stageName || options.stageId || '';
  const stageId = normalizeCopilotStageId(String(stageName));
  const stageEntry = stageId ? options.stageIndex?.get(stageId.toUpperCase()) : undefined;
  const uploader = copilotUploaderName(item.uploader, item.uploader_id);
  const uploadTime = typeof item.upload_time === 'string' ? item.upload_time : undefined;
  const match = options.ownedOperators && content.parsed
    ? resolveCopilotMatch(content.parsed, options.ownedOperators)
    : null;
  const details = copilotDocDetails(content.parsed);
  const operatorDetails = readCopilotOperatorDetails(content.parsed);
  const groupNames = readCopilotGroupNames(content.parsed);
  const recommendedMode = content.parsed ? copilotRecommendedMode(content.parsed.difficulty) : undefined;
  return {
    id: item.id,
    uri: `prts://${String(item.id)}`,
    views: item.views,
    hotScore: item.hot_score,
    title: content.title || '无标题',
    stageName,
    stageId,
    stageCode: stageEntry?.code ?? '',
    stageLabel: stageEntry?.name ?? '',
    operators: content.operators,
    ...(uploader === undefined ? {} : { uploader }),
    ...(uploadTime === undefined ? {} : { uploadTime }),
    ...(match ? { match } : {}),
    ...(details === undefined ? {} : { details }),
    ...(operatorDetails.length ? { operatorDetails } : {}),
    ...(groupNames.length ? { groupNames } : {}),
    ...(recommendedMode === undefined ? {} : { recommendedMode })
  };
}

export interface MaintenanceParadoxSearchPayload {
  operator: string;
  stageId: string;
  copilots: MaintenanceCopilotEntry[];
  recommended: MaintenanceCopilotEntry;
}

export interface MaintenanceCopilotSearchPayload {
  keyword: string;
  stage: string;
  stageId?: string;
  orderBy: MaintenanceCopilotSearchOrder;
  page: number;
  limit: number;
  total?: number;
  hasNext: boolean;
  copilots: MaintenanceCopilotSearchEntry[];
  recommended?: MaintenanceCopilotSearchEntry;
}

/** 维护动作计划：dryRun 只返回这些计划，不触发真实更新。 */
export interface MaintenanceUpdatePlanStep {
  action: string;
  targetChannel?: 'beta' | 'stable' | 'alpha' | 'current';
  command?: string;
  args?: string[];
}

export interface MaintenanceUpdateCorePlan {
  action: 'update-core-and-resources';
  steps: MaintenanceUpdatePlanStep[];
}

export interface MaintenanceUpdateCliPlan {
  action: 'update-cli';
  command: string;
  args?: string[];
  channel?: string;
  source?: string;
  supported?: boolean;
  reason?: string;
}

export interface MaintenanceHotUpdateResourcesPlan {
  action: 'hot-update-resources';
  command: 'hot-update';
}

export interface MaintenanceUpdateCorePayload {
  plan: MaintenanceUpdateCorePlan;
  steps: {
    core: { success: boolean; output: string };
    resources: { success: boolean; output: string };
  };
  channelPersisted: boolean;
  runtime: MaintenanceVersionPayload;
}

export interface MaintenanceUpdateCliPayload {
  output: string;
  plan: MaintenanceUpdateCliPlan;
}

export interface MaintenanceHotUpdateResourcesPayload extends ResourceUpdateResult {
  plan: MaintenanceHotUpdateResourcesPlan;
}

export interface MaintenanceVersionPayload extends MaaVersionInfo {
  resource: ResourceInfo;
  updateChannels?: {
    core: string;
    cli: string;
  };
}

export interface MaintenanceConfigDirectoryPayload {
  path: string;
}

export interface MaintenanceOpenConfigDirectoryPayload {
  configDir: string;
}
