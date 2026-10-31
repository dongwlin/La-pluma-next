import express from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import type { ReadRequest } from '../controllers/readDto.ts';
import * as agentDataController from '../controllers/agentDataController.ts';

/**
 * 游戏数据读取路由：只做端点映射，保持与抽离前一致的注册顺序。
 *
 * 连接覆盖解析与游戏日判定、掉落 envelope 的 `result.data || result` 选择、
 * `days` 数值归一与成功/失败 envelope 装配在
 * controllers/agentDataController.ts；读取只调用领域服务的读取入口，不触发
 * 仓库识别或干员识别等有副作用的动作。
 */
const router = express.Router();

router.get('/stages/open-today', asyncHandler<ReadRequest, ApiResponseWriter>(agentDataController.readTodayOpenStages));

router.get('/drops/today', asyncHandler<ReadRequest, ApiResponseWriter>(agentDataController.readTodayDrops));

router.get('/drops/recent', asyncHandler<ReadRequest, ApiResponseWriter>(agentDataController.readRecentDrops));

router.get('/drops/statistics', asyncHandler<ReadRequest, ApiResponseWriter>(agentDataController.readDropStatistics));

router.get('/data/depot', asyncHandler<ReadRequest, ApiResponseWriter>(agentDataController.readDepot));

router.get('/data/operbox', asyncHandler<ReadRequest, ApiResponseWriter>(agentDataController.readOperBox));

router.get('/data/operators', asyncHandler<ReadRequest, ApiResponseWriter>(agentDataController.readOperators));

export default router;
