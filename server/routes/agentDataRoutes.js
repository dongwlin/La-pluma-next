import express from 'express';
import { getTodayOpenStages } from '../services/notificationService.ts';
import { getTodayDrops, getRecentDrops, getDropStatistics, MAX_DROP_HISTORY_DAYS } from '../services/dropRecordService.ts';
import { getDepotData, getOperBoxData, getAllOperators } from '../services/dataParserService.ts';
import { asyncHandler, sendSuccess } from '../utils/apiHelper.ts';
import { resolveBoundedInteger } from '../utils/numericQueryHelper.ts';

/**
 * 游戏数据读取路由：今日开放关卡、掉落记录与本地仓库/干员缓存。
 *
 * 这里只调用领域服务的读取入口，不解析 MAA 日志、不重建缓存，也不触发
 * 仓库识别或干员识别；识别等有副作用的动作仍由独立动作入口承担。
 */
const router = express.Router();

router.get('/stages/open-today', asyncHandler(async (_req, res) => {
  return sendSuccess(res, _req, getTodayOpenStages(), '已获取今日开放日常关卡');
}));

router.get('/drops/today', asyncHandler(async (req, res) => {
  const result = await getTodayDrops();
  return sendSuccess(res, req, result.data || result, result.message || '操作成功');
}));

router.get('/drops/recent', asyncHandler(async (req, res) => {
  const days = resolveBoundedInteger(req.query.days, {
    defaultValue: 7,
    min: 1,
    max: MAX_DROP_HISTORY_DAYS
  });
  const result = await getRecentDrops(days);
  return sendSuccess(res, req, result.data || result, result.message || '操作成功');
}));

router.get('/drops/statistics', asyncHandler(async (req, res) => {
  const days = resolveBoundedInteger(req.query.days, {
    defaultValue: 7,
    min: 1,
    max: MAX_DROP_HISTORY_DAYS
  });
  const result = await getDropStatistics(days);
  return sendSuccess(res, req, result.data || result, result.message || '操作成功');
}));

router.get('/data/depot', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, await getDepotData());
}));

router.get('/data/operbox', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, await getOperBoxData());
}));

router.get('/data/operators', asyncHandler(async (req, res) => {
  return sendSuccess(res, req, await getAllOperators());
}));

export default router;
