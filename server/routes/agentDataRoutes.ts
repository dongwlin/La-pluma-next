import express from 'express';
import { getTodayOpenStages } from '../services/notificationService.ts';
import type { DailyStageOverview } from '../services/notificationService.ts';
import { isResourceCollectionOpen } from '../services/maaActivityService.ts';
import { getTodayDrops, getRecentDrops, getDropStatistics, MAX_DROP_HISTORY_DAYS } from '../services/dropRecordService.ts';
import type { DropRecordDay, DropStatistics } from '../services/dropRecordService.ts';
import { getDepotData, getOperBoxData, getAllOperators } from '../services/dataParserService.ts';
import type { DepotFile, OperBoxFile, OperatorSummary } from '../services/dataParserService.ts';
import { asyncHandler, sendSuccess } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import { resolveBoundedInteger } from '../utils/numericQueryHelper.ts';
import { readNumericQuery, readPayloadMessage, unwrapReadPayload } from './readDto.ts';
import type { ReadPayload, ReadRequest } from './readDto.ts';
import { resolveRequestConnection } from './requestConnection.ts';

/**
 * 游戏数据读取路由：今日开放关卡、掉落记录与本地仓库/干员缓存。
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
 */
const router = express.Router();

router.get('/stages/open-today', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  const { clientType } = await resolveRequestConnection(req, { allowOverrides: true });
  const allResourceStagesOpen = await isResourceCollectionOpen(clientType);
  const payload: DailyStageOverview = getTodayOpenStages({ clientType, allResourceStagesOpen });
  return sendSuccess(res, req, payload, '已获取今日开放日常关卡');
}));

router.get('/drops/today', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  const result = await getTodayDrops();
  const payload: ReadPayload<DropRecordDay> = unwrapReadPayload(result);
  return sendSuccess(res, req, payload, readPayloadMessage(result));
}));

router.get('/drops/recent', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  const days = resolveBoundedInteger(readNumericQuery(req.query, 'days'), {
    defaultValue: 7,
    min: 1,
    max: MAX_DROP_HISTORY_DAYS
  });
  const result = await getRecentDrops(days);
  const payload: ReadPayload<DropRecordDay[]> = unwrapReadPayload(result);
  return sendSuccess(res, req, payload, readPayloadMessage(result));
}));

router.get('/drops/statistics', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  const days = resolveBoundedInteger(readNumericQuery(req.query, 'days'), {
    defaultValue: 7,
    min: 1,
    max: MAX_DROP_HISTORY_DAYS
  });
  const result = await getDropStatistics(days);
  const payload: ReadPayload<DropStatistics> = unwrapReadPayload(result);
  return sendSuccess(res, req, payload, readPayloadMessage(result));
}));

router.get('/data/depot', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  const payload: DepotFile | null = await getDepotData();
  return sendSuccess(res, req, payload);
}));

router.get('/data/operbox', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  const payload: OperBoxFile | null = await getOperBoxData();
  return sendSuccess(res, req, payload);
}));

router.get('/data/operators', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  const payload: OperatorSummary[] = await getAllOperators();
  return sendSuccess(res, req, payload);
}));

export default router;
