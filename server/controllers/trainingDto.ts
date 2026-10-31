/**
 * 养成 HTTP DTO
 *
 * 把 Express 的未知输入收窄成领域类型；router 只做适配，不重新持有队列。
 * - 队列 revision、计划有效性、部分同步结果与材料算法仍由
 *   operatorTrainingService / operatorTrainingApplication 判定；
 * - 设置归一化（旧 `notify` 映射与未知扩展字段透传）仍由
 *   normalizeTrainingSettings 承担，这里只把非对象请求体归一为空对象。
 *
 * 兼容策略（按端点分别处理）：
 * - 候选 query 的 `profession`/`owned`/`needsElite2` 按标量字符串处理，
 *   重复参数与对象值沿用旧实现的严格比较结果（`owned`/`needsElite2`
 *   视为省略）；例外是 `profession` 的重复参数从“不匹配任何干员”
 *   变为“不参与过滤”。
 * - `rarity` 沿用既有 parseInt 语义（`'5abc'` → 5，重复参数与对象值经
 *   String 后同样解析），无法解析时省略；旧实现的 0/NaN 同样不参与过滤。
 * - `status` 只识别 trainable/owned/all；其它真值沿用旧 switch 默认分支的
 *   “全量”结果，缺省为 trainable。
 * - 队列 `operatorId` 必须是字符串，否则返回既有的 400 校验错误；旧实现
 *   会把它当作属性键继续查找，数字会以数值写入队列。
 * - 非数值 `position` 与非 current/all 的计划模式以领域同一错误（400、同一
 *   文案）拒绝；整数、队列长度与 409 revision 校验仍由领域承担。
 * - 计划应用只校验 `plan` 是否存在，`queueRevision` 冲突由领域返回 409；
 *   `settings` 原样交给领域，未知扩展字段不会被路由丢弃。
 */

import { agentError } from '../utils/apiHelper.ts';
import type { ApiRequestLike } from '../utils/apiHelper.ts';
import { isRecord, trainingError } from '../services/operatorTrainingModel.ts';
import type {
  TrainingCandidate,
  TrainingCandidateStatus,
  TrainingFlowMode,
  TrainingOperatorFilters
} from '../services/operatorTrainingModel.ts';
import type { QueueAddOptions } from '../services/operatorTrainingService.ts';

/** 养成路由处理器的请求端口：query/body 保持 unknown，由本模块按端点收窄。 */
export interface TrainingRequest extends ApiRequestLike {
  body?: unknown;
  params?: Record<string, string | undefined>;
}

/** 队列删除路由：`:operatorId` 由路由声明收窄为 string。 */
export interface TrainingQueueRemoveRequest extends TrainingRequest {
  params: { operatorId: string };
}

/** `/training/operators` 响应：候选投影与同一投影的计数。 */
export interface TrainingOperatorListPayload {
  operators: TrainingCandidate[];
  count: number;
}

/** 入队请求：领域仍负责材料数据、重复项与队列位置范围校验。 */
export interface TrainingQueueAddInput {
  operatorId: string;
  options: QueueAddOptions;
}

/** 计划应用请求：`plan`/`settings` 的真实校验在应用服务。 */
export interface TrainingApplyPlanInput {
  plan: unknown;
  settings: unknown;
}

/**
 * `rarity` 沿用旧实现的 parseInt 语义：无法解析时为省略（旧实现的 NaN
 * 不参与过滤，效果相同）；`'5abc'` 仍解析为 5。
 */
function parseRarity(value: unknown): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `profession` 只接受非空字符串，重复参数/对象值不再进入严格比较。 */
function parseProfession(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** `owned` 只识别显式的 true/false 字符串，其余按省略处理。 */
function parseOwned(value: unknown): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/**
 * `status` 的旧实现把缺失值归一为 trainable、其它真值落入 switch 默认分支
 * （全量）；这里保留同一结果并收窄为领域状态类型。
 */
function parseCandidateStatus(value: unknown): TrainingCandidateStatus {
  if (value === 'trainable' || value === 'owned' || value === 'all') return value;
  return value ? 'all' : 'trainable';
}

/** 候选列表过滤：每项独立归一，缺省值保持旧响应语义。 */
export function parseCandidateFilters(query: unknown): TrainingOperatorFilters {
  const source = isRecord(query) ? query : {};
  return {
    rarity: parseRarity(source.rarity),
    profession: parseProfession(source.profession),
    owned: parseOwned(source.owned),
    needsElite2: source.needsElite2 === 'true',
    status: parseCandidateStatus(source.status)
  };
}

/** 有限数值参与计算，其余值按省略处理（与领域的 toFiniteNumber 一致）。 */
function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 位置只接受数值；非数值沿用领域的既有错误文案，整数与队列长度范围
 * 仍由 operatorTrainingService 的 `Number.isInteger` / 队列长度校验决定。
 */
function parseQueuePosition(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  throw trainingError('position 必须是有效的队列位置');
}

/** 入队请求：operatorId 必须是字符串，数值选项只做类型收窄。 */
export function parseQueueAddBody(body: unknown): TrainingQueueAddInput {
  const source = isRecord(body) ? body : {};
  const operatorId = typeof source.operatorId === 'string' ? source.operatorId : '';
  if (!operatorId) {
    throw agentError('AGENT_VALIDATION_OPERATOR_ID_REQUIRED', '缺少 operatorId 参数', { statusCode: 400 });
  }
  return {
    operatorId,
    options: {
      currentElite: toFiniteNumber(source.currentElite),
      targetElite: toFiniteNumber(source.targetElite),
      position: parseQueuePosition(source.position)
    }
  };
}

/** 排序请求：只校验数组形状，元素类型、去重与完整性由领域校验。 */
export function parseQueueOrderBody(body: unknown): unknown[] {
  const source = isRecord(body) ? body : {};
  const operatorIds = source.operatorIds;
  if (!Array.isArray(operatorIds)) {
    throw agentError('AGENT_VALIDATION_OPERATOR_IDS_REQUIRED', 'operatorIds 必须是数组', { statusCode: 400 });
  }
  return operatorIds;
}

/** 设置请求：值保持 unknown，归一化与扩展字段透传由领域完成。 */
export function parseSettingsBody(body: unknown): Record<string, unknown> {
  return isRecord(body) ? body : {};
}

/** 计划模式：空值沿用旧实现的默认 current，非法值返回领域同一错误。 */
export function parsePlanModeBody(body: unknown): TrainingFlowMode {
  const source = isRecord(body) ? body : {};
  const mode = source.mode;
  if (!mode) return 'current';
  if (mode === 'current' || mode === 'all') return mode;
  throw trainingError('计划模式必须为 current 或 all');
}

/** 计划应用请求：只校验 plan 是否存在，queueRevision 冲突由领域返回 409。 */
export function parseApplyPlanBody(body: unknown): TrainingApplyPlanInput {
  const source = isRecord(body) ? body : {};
  const plan = source.plan;
  if (!plan) {
    throw agentError('AGENT_VALIDATION_PLAN_REQUIRED', '缺少 plan 参数', { statusCode: 400 });
  }
  return { plan, settings: source.settings };
}
