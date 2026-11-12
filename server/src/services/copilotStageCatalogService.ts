import { createOutboundHttpClient } from './outboundRequestService.ts';

const STAGE_CATALOG_URL = 'https://prts.maa.plus/arknights/level';
const STAGE_CATALOG_TTL_MS = 30 * 60_000;
const STAGE_CATALOG_RETRY_MS = 60_000;
const STAGE_CATALOG_TIMEOUT_MS = 20_000;
const STAGE_ID_INPUT = /^[a-z0-9][a-z0-9-]*(?:_[a-z0-9][a-z0-9-]*)+$/i;
const STAGE_CODE_SUFFIX = /[（(][^()（）]*[)）]\s*$/;

const outboundHttp = createOutboundHttpClient();

export interface CopilotStageCatalogEntry {
  readonly stageId: string;
  readonly code: string;
  readonly name: string;
  readonly category: string;
  readonly zone: string;
}

export type CopilotStageMatch =
  | { readonly status: 'matched'; readonly stage: CopilotStageCatalogEntry }
  | { readonly status: 'ambiguous'; readonly candidates: readonly CopilotStageCatalogEntry[] }
  | { readonly status: 'missing' };

export interface CopilotStageCatalogPorts {
  requestJson?: (url: string) => Promise<{ data: unknown }>;
  now?: () => number;
}

export interface CopilotStageCatalog {
  load(): Promise<readonly CopilotStageCatalogEntry[]>;
  resolve(input: unknown): Promise<CopilotStageMatch>;
  clear(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 作业站以 `#f#` 区分普通与突袭关卡，作业内容里的 `stage_name` 始终不含后缀。
 */
function normalizeStageId(value: string): string {
  return value.replace(/#[fn]#/g, '');
}

/**
 * 站点 `cat_three` 会带难度括注（如 `11-6（标准）`），玩家输入的代号通常不带。
 */
function normalizeStageCode(value: string): string {
  return value.trim().replace(STAGE_CODE_SUFFIX, '').trim();
}

export function parseCopilotStageCatalog(payload: unknown): CopilotStageCatalogEntry[] {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  const entries = new Map<string, CopilotStageCatalogEntry>();

  for (const item of list) {
    if (!isRecord(item)) continue;
    const stageId = normalizeStageId(readText(item.stage_id).trim());
    if (!stageId || entries.has(stageId)) continue;
    entries.set(stageId, {
      stageId,
      code: normalizeStageCode(readText(item.cat_three)),
      name: readText(item.name).trim(),
      category: readText(item.cat_one).trim(),
      zone: readText(item.cat_two).trim()
    });
  }

  return [...entries.values()];
}

export function matchCopilotStage(
  catalog: readonly CopilotStageCatalogEntry[],
  input: unknown
): CopilotStageMatch {
  const raw = String(input ?? '').trim();
  if (!raw) return { status: 'missing' };

  const upper = raw.toUpperCase();
  const exactId = catalog.find(entry => entry.stageId.toUpperCase() === upper);
  if (exactId) return { status: 'matched', stage: exactId };

  const code = normalizeStageCode(raw).toUpperCase();
  const byCode = code
    ? catalog.filter(entry => normalizeStageCode(entry.code).toUpperCase() === code)
    : [];
  if (byCode.length === 1) return { status: 'matched', stage: byCode[0]! };
  if (byCode.length > 1) return { status: 'ambiguous', candidates: byCode };

  const byName = catalog.filter(entry => entry.name && entry.name.toUpperCase() === upper);
  if (byName.length === 1) return { status: 'matched', stage: byName[0]! };
  if (byName.length > 1) return { status: 'ambiguous', candidates: byName };

  return { status: 'missing' };
}

async function defaultRequestJson(url: string): Promise<{ data: unknown }> {
  const result = await outboundHttp.requestJson(url, {
    timeoutMs: STAGE_CATALOG_TIMEOUT_MS,
    retry: { maxRetries: 0 }
  });
  return { data: result.data };
}

/**
 * 作业站关卡目录的唯一读取入口。缓存只保存站点数据的派生视图：
 * 过期后重新读取，刷新失败时继续使用上一份并短暂退避；
 * 输入已经是内部 stage id 时不依赖目录，站点不可用时仍可搜索。
 */
export function createCopilotStageCatalog(ports: CopilotStageCatalogPorts = {}): CopilotStageCatalog {
  const requestJson = ports.requestJson ?? defaultRequestJson;
  const now = ports.now ?? Date.now;
  let cached: { entries: readonly CopilotStageCatalogEntry[]; fetchedAt: number } | null = null;
  let inflight: Promise<readonly CopilotStageCatalogEntry[]> | null = null;

  const fetchEntries = async (): Promise<readonly CopilotStageCatalogEntry[]> => {
    const result = await requestJson(STAGE_CATALOG_URL);
    const entries = parseCopilotStageCatalog(result.data);
    if (!entries.length) throw new TypeError('作业站关卡目录为空或格式不正确');
    return entries;
  };

  const load = async (): Promise<readonly CopilotStageCatalogEntry[]> => {
    if (cached && now() - cached.fetchedAt < STAGE_CATALOG_TTL_MS) return cached.entries;
    if (inflight) return inflight;

    inflight = fetchEntries()
      .then(entries => {
        cached = { entries, fetchedAt: now() };
        return entries;
      })
      .catch(error => {
        const stale = cached;
        if (!stale) throw error;
        cached = { entries: stale.entries, fetchedAt: now() - STAGE_CATALOG_TTL_MS + STAGE_CATALOG_RETRY_MS };
        return stale.entries;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    load,
    resolve: async input => {
      const stageId = normalizeStageId(String(input ?? '').trim().toLowerCase());
      if (STAGE_ID_INPUT.test(stageId)) {
        return { status: 'matched', stage: { stageId, code: '', name: '', category: '', zone: '' } };
      }
      return matchCopilotStage(await load(), input);
    },
    clear: () => {
      cached = null;
      inflight = null;
    }
  };
}

export const copilotStageCatalog = createCopilotStageCatalog();

export function resetCopilotStageCatalogForTests(): void {
  copilotStageCatalog.clear();
}
