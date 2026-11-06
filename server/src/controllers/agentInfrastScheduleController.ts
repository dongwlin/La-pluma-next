import { agentError, sendSuccess } from '../utils/apiHelper.ts';
import type { ApiRequestLike, ApiResponseWriter } from '../utils/apiHelper.ts';
import { INFRASTRUCT_SCHEDULE_ERROR_CODES } from '../services/infrastScheduleService.ts';
import type { InfrastScheduleService } from '../services/infrastScheduleService.ts';

export interface InfrastScheduleRequest extends ApiRequestLike {
  query?: { name?: unknown };
  body?: unknown;
}

export interface InfrastScheduleSaveRequest {
  name: unknown;
  document: unknown;
}

function invalidRequest(message: string) {
  return agentError(INFRASTRUCT_SCHEDULE_ERROR_CODES.invalid, message, { statusCode: 400 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSaveRequest(body: unknown): InfrastScheduleSaveRequest {
  if (!isRecord(body)) throw invalidRequest('请求体必须是 JSON 对象');
  if (!Object.prototype.hasOwnProperty.call(body, 'name')) {
    throw invalidRequest('缺少 name 参数');
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'document')) {
    throw invalidRequest('缺少 document 参数');
  }
  return { name: body.name, document: body.document };
}

export function createInfrastScheduleController(service: InfrastScheduleService) {
  return {
    async list(req: InfrastScheduleRequest, res: ApiResponseWriter): Promise<void> {
      return sendSuccess(res, req, await service.list(), '已获取基建排班列表');
    },

    async read(req: InfrastScheduleRequest, res: ApiResponseWriter): Promise<void> {
      const name = req.query?.name;
      return sendSuccess(res, req, await service.read(name), '已获取基建排班文件');
    },

    async save(req: InfrastScheduleRequest, res: ApiResponseWriter): Promise<void> {
      const { name, document } = parseSaveRequest(req.body);
      return sendSuccess(res, req, await service.save(name, document), '基建排班文件已保存');
    }
  };
}
