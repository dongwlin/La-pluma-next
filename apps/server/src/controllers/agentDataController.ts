import { getTodayOpenStages } from '../services/notificationService.ts';
import type { DailyStageOverview } from '../services/notificationService.ts';
import { isResourceCollectionOpen } from '../services/maaActivityService.ts';
import { getTodayDrops, getRecentDrops, getDropStatistics, MAX_DROP_HISTORY_DAYS } from '../services/dropRecordService.ts';
import { getDepotData, getOperBoxData, getAllOperators } from '../services/dataParserService.ts';
import { resolveBoundedInteger } from '../utils/numericQueryHelper.ts';
import { sendSuccess } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import { readNumericQuery, readPayloadMessage, unwrapReadPayload } from './readDto.ts';
import type { ReadRequest } from './readDto.ts';
import { resolveRequestConnection } from './requestConnection.ts';

export async function readTodayOpenStages(req: ReadRequest, res: ApiResponseWriter): Promise<void> {
  const { clientType } = await resolveRequestConnection(req, { allowOverrides: true });
  const allResourceStagesOpen = await isResourceCollectionOpen(clientType);
  const payload: DailyStageOverview = getTodayOpenStages({ clientType, allResourceStagesOpen });
  return sendSuccess(res, req, payload, '已获取今日开放日常关卡');
}

export async function readTodayDrops(req: ReadRequest, res: ApiResponseWriter): Promise<void> {
  const result = await getTodayDrops();
  return sendSuccess(res, req, unwrapReadPayload(result), readPayloadMessage(result));
}

export async function readRecentDrops(req: ReadRequest, res: ApiResponseWriter): Promise<void> {
  const days = resolveBoundedInteger(readNumericQuery(req.query, 'days'), {
    defaultValue: 7,
    min: 1,
    max: MAX_DROP_HISTORY_DAYS
  });
  const result = await getRecentDrops(days);
  return sendSuccess(res, req, unwrapReadPayload(result), readPayloadMessage(result));
}

export async function readDropStatistics(req: ReadRequest, res: ApiResponseWriter): Promise<void> {
  const days = resolveBoundedInteger(readNumericQuery(req.query, 'days'), {
    defaultValue: 7,
    min: 1,
    max: MAX_DROP_HISTORY_DAYS
  });
  const result = await getDropStatistics(days);
  return sendSuccess(res, req, unwrapReadPayload(result), readPayloadMessage(result));
}

export async function readDepot(req: ReadRequest, res: ApiResponseWriter): Promise<void> {
  return sendSuccess(res, req, await getDepotData());
}

export async function readOperBox(req: ReadRequest, res: ApiResponseWriter): Promise<void> {
  return sendSuccess(res, req, await getOperBoxData());
}

export async function readOperators(req: ReadRequest, res: ApiResponseWriter): Promise<void> {
  return sendSuccess(res, req, await getAllOperators());
}
