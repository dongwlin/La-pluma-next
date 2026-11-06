import express from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import type { ReadRequest } from '../controllers/readDto.ts';
import * as agentDiagnosticsController from '../controllers/agentDiagnosticsController.ts';

const router = express.Router();

// 诊断结论只代表探测时刻，响应不能被浏览器或中间代理缓存。
router.get(
  '/diagnostics',
  (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  },
  asyncHandler<ReadRequest, ApiResponseWriter>(agentDiagnosticsController.readDiagnostics)
);

export default router;
