import express from 'express';
import { asyncHandler, sendSuccess } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import type { ReadRequest } from '../controllers/readDto.ts';
import * as agentDataController from '../controllers/agentDataController.ts';

/**
 * 游戏数据读取路由：只做端点映射与 envelope 装配。
 *
 * 连接覆盖解析与游戏日判定、掉落 envelope 的 `result.data || result` 选择
 * 及 `days` 数值归一在 controllers/agentDataController.ts；读取只调用领域
 * 服务的读取入口，不触发仓库识别或干员识别等有副作用的动作。
 */
const router = express.Router();

router.get('/stages/open-today', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await agentDataController.readTodayOpenStages(req), '已获取今日开放日常关卡');
}));

router.get('/drops/today', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  const { payload, message } = await agentDataController.readTodayDrops();
  return sendSuccess(res, req, payload, message);
}));

router.get('/drops/recent', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  const { payload, message } = await agentDataController.readRecentDrops(req);
  return sendSuccess(res, req, payload, message);
}));

router.get('/drops/statistics', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  const { payload, message } = await agentDataController.readDropStatistics(req);
  return sendSuccess(res, req, payload, message);
}));

router.get('/data/depot', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await agentDataController.readDepot());
}));

router.get('/data/operbox', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await agentDataController.readOperBox());
}));

router.get('/data/operators', asyncHandler<ReadRequest, ApiResponseWriter>(async (req, res) => {
  return sendSuccess(res, req, await agentDataController.readOperators());
}));

export default router;
