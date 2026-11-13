import express from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import type { ReadRequest } from '../controllers/readDto.ts';
import * as agentDataController from '../controllers/agentDataController.ts';

const router = express.Router();

router.get('/stages/open-today', asyncHandler<ReadRequest, ApiResponseWriter>(agentDataController.readTodayOpenStages));

router.get('/drops/today', asyncHandler<ReadRequest, ApiResponseWriter>(agentDataController.readTodayDrops));

router.get('/drops/recent', asyncHandler<ReadRequest, ApiResponseWriter>(agentDataController.readRecentDrops));

router.get('/drops/statistics', asyncHandler<ReadRequest, ApiResponseWriter>(agentDataController.readDropStatistics));

router.get('/data/depot', asyncHandler<ReadRequest, ApiResponseWriter>(agentDataController.readDepot));

router.get('/data/operbox', asyncHandler<ReadRequest, ApiResponseWriter>(agentDataController.readOperBox));

router.get('/data/operators', asyncHandler<ReadRequest, ApiResponseWriter>(agentDataController.readOperators));

export default router;
