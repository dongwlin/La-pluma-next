import { agentError } from '../utils/apiHelper.ts';
import type { ApiRequestLike } from '../utils/apiHelper.ts';
import { isRecord, trainingError } from '../services/operatorTrainingModel.ts';
import type {
  TrainingCandidate,
  TrainingCandidateStatus,
  TrainingFlowMode,
  TrainingOperatorFilters
} from '../services/operatorTrainingModel.ts';
import type { OperatorRecognitionSummary } from '../services/operatorCatalogModel.ts';
import type { QueueAddOptions } from '../services/operatorTrainingService.ts';

/** 养成路由处理器的请求端口：query/body 保持 unknown，由本模块按端点收窄。 */
export interface TrainingRequest extends ApiRequestLike {
  body?: unknown;
  params?: Record<string, string | undefined>;
}

export interface TrainingQueueRemoveRequest extends TrainingRequest {
  params: { operatorId: string };
}

export interface TrainingOperatorListPayload {
  operators: TrainingCandidate[];
  count: number;
  recognition: OperatorRecognitionSummary;
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

function parseProfession(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

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
