import {
  agentError,
  sendSuccess
} from '../utils/apiHelper.ts';
import type { ApiRequestLike, ApiResponseWriter } from '../utils/apiHelper.ts';
import {
  CopilotFileInvalidError,
  saveCopilotFile
} from '../services/copilotFileService.ts';
import type { CopilotFileInput, CopilotFileResult } from '../services/copilotFileService.ts';

export interface CopilotFileRequest extends ApiRequestLike {
  body?: unknown;
}

export type CopilotFileResponseWriter = ApiResponseWriter;

export type CopilotFileSaver = (input: CopilotFileInput) => Promise<CopilotFileResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readCopilotFileInput(body: unknown): CopilotFileInput {
  if (!isRecord(body)) {
    throw agentError('COPILOT_FILE_INVALID', '请求体必须是 JSON 对象', {
      statusCode: 400,
      details: { reason: 'body_not_object' }
    });
  }
  return { name: body.name, content: body.content };
}

function invalidCopilotFileError(error: CopilotFileInvalidError): Error {
  return agentError('COPILOT_FILE_INVALID', error.message, {
    statusCode: 400,
    details: { reason: error.reason }
  });
}

export function createCopilotFileHandler(
  saveFile: CopilotFileSaver = saveCopilotFile
): (req: CopilotFileRequest, res: CopilotFileResponseWriter) => Promise<void> {
  return async (req, res) => {
    const input = readCopilotFileInput(req.body);
    try {
      const saved = await saveFile(input);
      sendSuccess(res, req, saved, '作业文件已保存');
    } catch (error) {
      if (error instanceof CopilotFileInvalidError) {
        throw invalidCopilotFileError(error);
      }
      throw error;
    }
  };
}
