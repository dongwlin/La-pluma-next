import operatorTrainingService from '../services/operatorTrainingService.ts';
import type { TrainingQueueSnapshot } from '../services/operatorTrainingService.ts';
import type { TrainingSettings } from '../services/operatorTrainingModel.ts';
import type { ApplyPlanResult, QueueMutationResult } from '../services/operatorTrainingApplication.ts';
import type { TrainingPlan } from '../services/operatorTrainingPlan.ts';
import { isRecord } from '../services/operatorTrainingModel.ts';
import { sendDryRun, sendSuccess } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import {
  parseApplyPlanBody,
  parseCandidateFilters,
  parsePlanModeBody,
  parseQueueAddBody,
  parseQueueOrderBody,
  parseSettingsBody
} from './trainingDto.ts';
import type {
  TrainingOperatorListPayload,
  TrainingQueueRemoveRequest,
  TrainingRequest
} from './trainingDto.ts';
import { resolveRequestConnection } from './requestConnection.ts';

/**
 * 养成控制器：候选干员、队列、设置、计划生成与应用。
 *
 * 这里只做 query/body 收窄和响应适配；队列 revision、计划有效性校验
 * （含旧 `queueRevision` 冲突）、候选/计数投影与变更串行化仍由
 * operatorTrainingService 承担，这里不复制这些判定，也不读取队列或
 * 计算材料。
 *
 * 请求的未知值在 trainingDto 按端点分别收窄；响应沿用领域 DTO
 * （TrainingQueueSnapshot、QueueMutationResult、ApplyPlanResult 等），
 * 不另行拼装字段。
 *
 * 队列写入与流程/定时同步是不同结果：服务在队列已保存但流程或定时同步
 * 失败时仍返回 `queueUpdated` 与 `flowSync`/`scheduleSync` 诊断字段，接口
 * 继续按成功响应返回，不能把部分成功改写成整体失败。
 * `/actions/fetch-training-materials` 只执行数据拉取脚本，不占设备执行租约。
 *
 * 成功/失败 envelope 由本控制器的各 handler 经 sendSuccess / sendDryRun
 * 统一装配；`/training/sync` 的响应消息由同步结果推导后与载荷一并发送，
 * `/actions/fetch-training-materials` 的 dryRun 计划经 sendDryRun 发送。
 * 路由层（agentTrainingRoutes.ts）只做端点映射。
 */

/** `/training/operators` 的候选干员读取：query 过滤在 trainingDto 按旧实现语义收窄。 */
export async function listCandidates(req: TrainingRequest, res: ApiResponseWriter): Promise<void> {
  const operators = await operatorTrainingService.getOperatorList(parseCandidateFilters(req.query));
  const payload: TrainingOperatorListPayload = { operators, count: operators.length };
  return sendSuccess(res, req, payload);
}

/** `/training/queue` 的队列快照读取。 */
export async function readQueue(req: TrainingRequest, res: ApiResponseWriter): Promise<void> {
  const payload: TrainingQueueSnapshot = await operatorTrainingService.getTrainingQueue();
  return sendSuccess(res, req, payload);
}

/** `/training/queue` 的入队：operatorId 与数值选项先经 trainingDto 收窄。 */
export async function addQueueItem(req: TrainingRequest, res: ApiResponseWriter): Promise<void> {
  const { operatorId, options } = parseQueueAddBody(req.body);
  return sendSuccess(res, req, await operatorTrainingService.addToQueue(operatorId, options), '已添加到养成队列');
}

/** `/training/queue/:operatorId` 的出队：移除与同步语义由领域服务承担。 */
export async function removeQueueItem(req: TrainingQueueRemoveRequest, res: ApiResponseWriter): Promise<void> {
  const payload: QueueMutationResult = await operatorTrainingService.removeFromQueue(req.params.operatorId);
  return sendSuccess(res, req, payload, '已从养成队列中移除');
}

/** `/training/queue/order` 的排序：数组形状先经 trainingDto 校验，元素完整性由领域校验。 */
export async function updateQueueOrder(req: TrainingRequest, res: ApiResponseWriter): Promise<void> {
  const payload: QueueMutationResult = await operatorTrainingService.updateQueueOrder(parseQueueOrderBody(req.body));
  return sendSuccess(res, req, payload, '队列顺序已更新');
}

/**
 * `/training/sync` 的任务流程同步：部分成功不改写为整体失败，流程或定时
 * 同步失败时响应消息仍按失败提示，载荷保留服务的诊断字段。
 */
export async function syncFlow(req: TrainingRequest, res: ApiResponseWriter): Promise<void> {
  const result = await operatorTrainingService.syncTrainingFlow();
  return sendSuccess(res, req, result, result.flowSync.status === 'failed' ? '任务流程同步失败，可重试' : '任务流程同步状态已更新');
}

/** `/training/settings` 的设置更新：值保持 unknown，归一化与扩展字段透传由领域完成。 */
export async function updateSettings(req: TrainingRequest, res: ApiResponseWriter): Promise<void> {
  const payload: TrainingSettings = await operatorTrainingService.updateSettings(parseSettingsBody(req.body));
  return sendSuccess(res, req, payload, '设置已更新');
}

/** `/training/plan` 的计划生成：模式校验与连接解析次序保持旧实现。 */
export async function generatePlan(req: TrainingRequest, res: ApiResponseWriter): Promise<void> {
  // 模式先校验：非法请求不解析连接；关卡开放按连接 profile 的客户端游戏日判定。
  const mode = parsePlanModeBody(req.body);
  const { clientType } = await resolveRequestConnection(req, { allowOverrides: true });
  const payload: TrainingPlan = await operatorTrainingService.generateTrainingPlan(mode, { clientType });
  return sendSuccess(res, req, payload);
}

/** `/actions/apply-training-plan` 的计划应用：`queueRevision` 冲突由领域返回 409。 */
export async function applyPlan(req: TrainingRequest, res: ApiResponseWriter): Promise<void> {
  const { plan, settings } = parseApplyPlanBody(req.body);
  const payload: ApplyPlanResult = await operatorTrainingService.applyPlanToTasks(plan, settings);
  return sendSuccess(res, req, payload, '养成计划已应用到任务流程');
}

/** `/actions/fetch-training-materials` 的 dry-run 计划载荷。 */
export interface TrainingMaterialFetchPlan {
  action: string;
  sideEffects: string[];
}

/**
 * `/actions/fetch-training-materials` 的养成材料数据拉取：只执行数据拉取
 * 脚本，不占设备执行租约；dryRun 只返回计划并经 sendDryRun 发送。
 */
export async function fetchMaterials(req: TrainingRequest, res: ApiResponseWriter): Promise<void> {
  const plan: TrainingMaterialFetchPlan = { action: 'fetch-training-materials', sideEffects: ['refresh_training_material_cache'] };
  // 旧实现的 `req.body?.dryRun` 对非对象请求体同样不触发 dryRun。
  if (isRecord(req.body) && req.body.dryRun) {
    return sendDryRun(res, req, plan);
  }
  return sendSuccess(res, req, await operatorTrainingService.fetchOperatorMaterials(), '养成材料数据已更新');
}
