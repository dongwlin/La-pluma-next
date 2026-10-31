/**
 * 维护 HTTP DTO
 *
 * 把 Express 与上游的未知输入收窄成维护适配需要的类型；router 只做 HTTP 适配，
 * 连接/profile 解析、资源与核心更新、定时注册、识别动作与出站查询仍由各自服务
 * 所有者承担。
 *
 * 请求侧按端点分别收窄：
 * - profile 保存体保持旧实现的 `req.body || {}`，顶层形状、字段白名单与原子写入
 *   仍由 maaConfigService 判定，非对象请求体继续以同一 500 失败；
 * - `dryRun` 沿用旧实现的真值判定（`Boolean`），字符串 `'false'` 仍按真值处理；
 * - 更新渠道只与 `beta`/`stable` 全等比较，其它值保持原样进入计划、错误详情与
 *   完成文案，不在这里改写；
 * - 定时注册的 `scheduleId` 沿用旧默认值 `default`（仅在缺省时生效），非字符串
 *   按文本收窄；`times`/`taskFlow` 保持 unknown，校验与注册仍由
 *   schedulerService 判定；
 * - 自动更新配置按既有 `AutoUpdateConfig` 透传：启用判定读取 `enabled`/`time`
 *   的真值，扩展字段原样保留并在响应中回显；
 * - 查询参数（悖论干员名、作业关卡、计划 raid）按标量字符串收窄，缺失时保持
 *   旧实现的空值语义。
 *
 * 上游侧只做结构收窄：GitHub releases 必须为数组（非数组按上游响应异常抛出，
 * 由调用方映射既有 502），PRTS 作业查询信封保留 `status_code`/`has_next` 原值，
 * 非对象条目跳过。字段本身未经运行期校验，按 unknown 原样透传，本层不补造或
 * 改写上游值。
 */

import type { ApiRequestLike } from '../utils/apiHelper.ts';
import type { ConnectionProfile } from '../services/connectionService.ts';
import type { MaaVersionInfo } from '../services/maaExecutionService.ts';
import type { MaaActivityFailure, MaaActivityStatus } from '../services/maaActivityService.ts';
import type { ResourceInfo, ResourceUpdateResult } from '../services/resourceUpdateService.ts';
import type { AutoUpdateConfig } from '../services/scheduleTriggerService.ts';
import { resolveRequestConnection } from '../controllers/requestConnection.ts';

/** 维护路由处理器的请求端口：query/body 保持 unknown，由本模块按端点收窄。 */
export interface MaintenanceRequest extends ApiRequestLike {
  body?: unknown;
  query?: unknown;
}

/** 连接/profile 路由：`:profileName` 由路由声明收窄为 string。 */
export interface MaintenanceProfileRequest extends MaintenanceRequest {
  params: { profileName: string };
}

/** 作业集/作业读取路由：`:id` 由路由声明收窄为 string。 */
export interface MaintenanceCopilotRequest extends MaintenanceRequest {
  params: { id: string };
}

/** 定时停止路由：`:scheduleId` 由路由声明收窄为 string。 */
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

/**
 * 连接选择沿用请求级连接覆盖解析：query 与 body 合并后按 profile 解析，
 * 允许 adbPath/address/clientType 覆盖。
 */
export function resolveMaintenanceConnection(request: MaintenanceRequest): Promise<ConnectionProfile> {
  return resolveRequestConnection(request, { allowOverrides: true });
}

/**
 * profile 保存体：Express 5 未解析或缺失请求体按旧实现的 `|| {}` 归一为空对象；
 * 返回 unknown 是因为顶层形状与 connection 合并规则仍由 maaConfigService 校验，
 * 这里不能先收窄成对象而改变非对象请求体的既有结果。
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

/** 悖论模拟查询：干员名去掉首尾空白，缺失时为空串（沿用旧校验分支）。 */
export interface MaintenanceParadoxSearchInput {
  name: string;
}

export function parseParadoxSearchQuery(query: unknown): MaintenanceParadoxSearchInput {
  const source = isRecord(query) ? query : {};
  return { name: String(source.name || '').trim() };
}

/** 作业查询：关卡名去掉首尾空白，缺失时为空串（沿用旧校验分支）。 */
export interface MaintenanceCopilotSearchInput {
  stage: string;
}

export function parseCopilotSearchQuery(query: unknown): MaintenanceCopilotSearchInput {
  const source = isRecord(query) ? query : {};
  return { stage: String(source.stage || '').trim() };
}

/** 作业集计划模式：只识别 normal/raid/both，其它值与缺失值都回落到 normal。 */
export type MaintenanceCopilotRaid = 'normal' | 'raid' | 'both';

const COPILOT_RAID_MODES: readonly MaintenanceCopilotRaid[] = ['normal', 'raid', 'both'];

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
export function resourceInfoFallback(error: unknown): ResourceInfo {
  return {
    lastUpdated: null,
    modifiedAt: null,
    ageDays: null,
    status: 'unknown',
    message: `资源版本读取失败: ${thrownMessage(error)}`,
    activity: null,
    gacha: null
  };
}

/** 活动响应载荷：只描述本入口拼装的字段，stages 原样取自活动查询。 */
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

/** GitHub releases 条目：只保留本入口读取或回显的字段。 */
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
}

export function parsePrtsCopilotQueryPayload(value: unknown): PrtsCopilotQueryPayload {
  if (!isRecord(value)) {
    throw new TypeError('PRTS 作业查询响应不是对象');
  }
  const body = isRecord(value.data) ? value.data : {};
  return {
    statusCode: value.status_code,
    items: Array.isArray(body.data) ? body.data.filter(isRecord) : [],
    hasNext: Boolean(body.has_next)
  };
}

/** 作业条目投影：上游字段原样透传，只补展示用的 uri 与标题。 */
export interface MaintenanceCopilotEntry {
  id: unknown;
  uri: string;
  views: unknown;
  hotScore: unknown;
  uploader: unknown;
  title: unknown;
}

/** 关卡查询条目额外回显作业自带的关卡名。 */
export interface MaintenanceCopilotSearchEntry extends MaintenanceCopilotEntry {
  stageName: unknown;
}

/** 关卡查询候选：条目加用于匹配请求关卡的标题代号。 */
export interface MaintenanceCopilotSearchCandidate {
  entry: MaintenanceCopilotSearchEntry;
  titleStageCode: string;
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

/** 悖论模拟作业条目。 */
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

/**
 * 关卡作业条目：标题与关卡名来自 content 文档，标题代号用于与请求关卡匹配；
 * content 不是 JSON 时沿用默认标题与请求关卡。
 */
export function projectCopilotSearchItem(
  item: Record<string, unknown>,
  stage: string
): MaintenanceCopilotSearchCandidate {
  let title: unknown = '无标题';
  let stageName: unknown = stage;
  let titleStageCode = '';
  try {
    const content = JSON.parse(String(item.content || '{}'));
    title = copilotDocTitle(content) || '无标题';
    stageName = isRecord(content) && content.stage_name ? content.stage_name : stage;
    if (typeof title === 'string') {
      const titleMatch = title.match(/^([A-Z]{2,4}-\d+[A-Z]?)/i);
      if (titleMatch) titleStageCode = titleMatch[1].toUpperCase();
    }
  } catch {
    // 非 JSON content：沿用默认标题与请求关卡
  }
  return {
    entry: {
      id: item.id,
      uri: `prts://${String(item.id)}`,
      views: item.views,
      hotScore: item.hot_score,
      uploader: item.uploader_id,
      title,
      stageName
    },
    titleStageCode
  };
}

/** `GET /paradox/search` 响应。 */
export interface MaintenanceParadoxSearchPayload {
  operator: string;
  stageId: string;
  copilots: MaintenanceCopilotEntry[];
  recommended: MaintenanceCopilotEntry;
}

/** `GET /copilot/search` 响应。 */
export interface MaintenanceCopilotSearchPayload {
  stage: string;
  copilots: MaintenanceCopilotSearchEntry[];
  recommended: MaintenanceCopilotSearchEntry;
}

/** 维护动作计划：dryRun 只返回这些计划，不触发真实更新。 */
export interface MaintenanceUpdatePlanStep {
  action: string;
  targetChannel?: 'beta' | 'stable' | 'current';
  command?: string;
  args?: string[];
  script?: string;
}

export interface MaintenanceUpdateCorePlan {
  action: 'update-core-and-resources';
  steps: MaintenanceUpdatePlanStep[];
}

export interface MaintenanceUpdateCliPlan {
  action: 'update-cli';
  command: string;
}

export interface MaintenanceHotUpdateResourcesPlan {
  action: 'hot-update-resources';
  script: string;
}

/** 核心更新响应：计划、两步结果与更新后的运行时版本。 */
export interface MaintenanceUpdateCorePayload {
  plan: MaintenanceUpdateCorePlan;
  steps: {
    core: { success: true; output: string };
    resources: { success: true; output: string };
  };
  runtime: MaintenanceVersionPayload;
}

/** CLI 更新响应：命令输出与计划。 */
export interface MaintenanceUpdateCliPayload {
  output: string;
  plan: MaintenanceUpdateCliPlan;
}

/** 资源热更新响应：资源更新结果与计划。 */
export interface MaintenanceHotUpdateResourcesPayload extends ResourceUpdateResult {
  plan: MaintenanceHotUpdateResourcesPlan;
}

/** `/version` 响应：MAA 版本信息加资源投影。 */
export interface MaintenanceVersionPayload extends MaaVersionInfo {
  resource: ResourceInfo;
}

/** `/config-directory` 与打开配置目录动作的响应。 */
export interface MaintenanceConfigDirectoryPayload {
  path: string;
}

export interface MaintenanceOpenConfigDirectoryPayload {
  configDir: string;
}
