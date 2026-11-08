import { Router } from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import {
  createCopilotFileHandler
} from '../controllers/copilotFileController.ts';
import type {
  CopilotFileRequest,
  CopilotFileSaver
} from '../controllers/copilotFileController.ts';

export interface CopilotFilesRouterOptions {
  saveFile?: CopilotFileSaver;
}

export function createCopilotFilesRouter(options: CopilotFilesRouterOptions = {}): Router {
  const router = Router();
  router.post(
    '/',
    asyncHandler<CopilotFileRequest, ApiResponseWriter>(createCopilotFileHandler(options.saveFile))
  );
  return router;
}
