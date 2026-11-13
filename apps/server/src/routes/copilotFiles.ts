import { Router } from 'express';
import { asyncHandler } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import {
  createCopilotFileHandler
} from '../controllers/copilotFileController.ts';
import type {
  CopilotFileRequest,
  CopilotFileSaver,
  CopilotStageResolver
} from '../controllers/copilotFileController.ts';

export interface CopilotFilesRouterOptions {
  saveFile?: CopilotFileSaver;
  resolveStage?: CopilotStageResolver;
}

export function createCopilotFilesRouter(options: CopilotFilesRouterOptions = {}): Router {
  const router = Router();
  router.post(
    '/',
    asyncHandler<CopilotFileRequest, ApiResponseWriter>(
      createCopilotFileHandler(options.saveFile, options.resolveStage)
    )
  );
  return router;
}
