import { getTodayOpenStages } from '../services/notificationService.ts';
import type { DailyStageOverview } from '../services/notificationService.ts';
import { isResourceCollectionOpen } from '../services/maaActivityService.ts';
import { getTodayDrops, getRecentDrops, getDropStatistics, MAX_DROP_HISTORY_DAYS } from '../services/dropRecordService.ts';
import type { DropRecordDay, DropStatistics } from '../services/dropRecordService.ts';
import { getDepotData, getOperBoxData, getAllOperators } from '../services/dataParserService.ts';
import type { DepotFile, OperBoxFile, OperatorSummary } from '../services/dataParserService.ts';
import { resolveBoundedInteger } from '../utils/numericQueryHelper.ts';
import { readNumericQuery, readPayloadMessage, unwrapReadPayload } from './readDto.ts';
import type { ReadPayload, ReadRequest } from './readDto.ts';
import { resolveRequestConnection } from './requestConnection.ts';

/**
 * 游戏数据读取控制器：今日开放关卡、掉落记录与本地仓库/干员缓存。
 *
 * 这里只调用领域服务的读取入口，不解析 MAA 日志、不重建缓存，也不触发
 * 仓库识别或干员识别；识别等有副作用的动作仍由独立动作入口承担。
 *
 * 今日开放关卡按连接 profile 的客户端类型判定游戏日；`?clientType=` 与其它
 * 读取入口一样可覆盖 profile，缺省值由连接服务补齐。资源收集全开放活动期间
 * 所有资源本按开放投影，窗口由活动服务按同一客户端类型解析。
 *
 * 掉落读取沿用服务的统一 envelope：成功时取 `data`、失败时原样返回
 * envelope，与拆分前的 `result.data || result` 选择一致；`days` 仍是单值
 * query，重复参数与非法值由数值归一回落默认值。
 *
 * 控制器只返回业务载荷：成功/失败 envelope 由路由层的 sendSuccess 统一
 * 封装；掉落端点的响应消息由读取结果推导后与载荷一并交回路由。
 */

/** 掉落读取的载荷出口：payload 保留服务的统一 envelope 选择，message 由结果推导。 */
export interface DropReadOutcome<T> {
  payload: ReadPayload<T>;
  message: string;
}

/** `/stages/open-today` 的今日开放关卡读取：先解析连接覆盖，再按客户端类型判定游戏日。 */
export async function readTodayOpenStages(req: ReadRequest): Promise<DailyStageOverview> {
  const { clientType } = await resolveRequestConnection(req, { allowOverrides: true });
  const allResourceStagesOpen = await isResourceCollectionOpen(clientType);
  const payload: DailyStageOverview = getTodayOpenStages({ clientType, allResourceStagesOpen });
  return payload;
}

/** `/drops/today` 的今日掉落读取：沿用掉落服务的统一 envelope。 */
export async function readTodayDrops(): Promise<DropReadOutcome<DropRecordDay>> {
  const result = await getTodayDrops();
  const payload: ReadPayload<DropRecordDay> = unwrapReadPayload(result);
  return { payload, message: readPayloadMessage(result) };
}

/** `/drops/recent` 的历史掉落读取：`days` 缺省 7，上限为掉落历史的既有上限。 */
export async function readRecentDrops(req: ReadRequest): Promise<DropReadOutcome<DropRecordDay[]>> {
  const days = resolveBoundedInteger(readNumericQuery(req.query, 'days'), {
    defaultValue: 7,
    min: 1,
    max: MAX_DROP_HISTORY_DAYS
  });
  const result = await getRecentDrops(days);
  const payload: ReadPayload<DropRecordDay[]> = unwrapReadPayload(result);
  return { payload, message: readPayloadMessage(result) };
}

/** `/drops/statistics` 的掉落统计读取：`days` 归一规则与历史掉落一致。 */
export async function readDropStatistics(req: ReadRequest): Promise<DropReadOutcome<DropStatistics>> {
  const days = resolveBoundedInteger(readNumericQuery(req.query, 'days'), {
    defaultValue: 7,
    min: 1,
    max: MAX_DROP_HISTORY_DAYS
  });
  const result = await getDropStatistics(days);
  const payload: ReadPayload<DropStatistics> = unwrapReadPayload(result);
  return { payload, message: readPayloadMessage(result) };
}

/** `/data/depot` 的本地仓库缓存读取。 */
export async function readDepot(): Promise<DepotFile | null> {
  const payload: DepotFile | null = await getDepotData();
  return payload;
}

/** `/data/operbox` 的本地干员缓存读取。 */
export async function readOperBox(): Promise<OperBoxFile | null> {
  const payload: OperBoxFile | null = await getOperBoxData();
  return payload;
}

/** `/data/operators` 的干员清单读取。 */
export async function readOperators(): Promise<OperatorSummary[]> {
  const payload: OperatorSummary[] = await getAllOperators();
  return payload;
}
