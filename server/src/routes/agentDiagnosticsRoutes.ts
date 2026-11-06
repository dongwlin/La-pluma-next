import express from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import type { ReadRequest } from '../controllers/readDto.ts';
import * as agentDiagnosticsController from '../controllers/agentDiagnosticsController.ts';

const router = express.Router();

router.get('/diagnostics', asyncHandler<ReadRequest, ApiResponseWriter>(agentDiagnosticsController.readDiagnostics));

export default router;
