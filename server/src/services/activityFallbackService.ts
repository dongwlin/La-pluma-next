import { createOutboundHttpClient } from './outboundRequestService.ts';
import { DEFAULT_CLIENT_TYPE } from '../config/connectionDefaults.ts';

const PENGUIN_API_BASE = 'https://penguin-stats.io/PenguinStats/api/v2';
const CACHE_TTL = 30 * 60 * 1000;
const outboundHttp = createOutboundHttpClient({ defaultTimeoutMs: 5000 });
const CLIENT_SERVERS: Record<string, string | undefined> = {
  Official: 'CN',
  Bilibili: 'CN',
  YoStarEN: 'US',
  YoStarJP: 'JP',
  YoStarKR: 'KR'
};

/** 该服务区是否有备用数据源映射；不支持时不能把 null 当成“没有活动”。 */
export function supportsFallbackClient(clientType: string = DEFAULT_CLIENT_TYPE): boolean {
  return typeof CLIENT_SERVERS[clientType] === 'string';
}

export interface PenguinActivity {
  code: string;
  name: string;
  source: 'penguin';
  startTime: number;
  endTime: number | null;
  stages: string[];
}

interface ActivityWindow {
  openTime: number;
  closeTime: number | null;
}

const cache = new Map<string, { timestamp: number; value: PenguinActivity | null }>();
const activeRequests = new Map<string, Promise<PenguinActivity | null>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function getActiveExistence(item: unknown, server: string, now: number): ActivityWindow | null {
  const existence = isRecord(item) && isRecord(item.existence) ? item.existence[server] : undefined;
  if (!isRecord(existence) || !existence.exist) return null;

  const openTime = Number(existence.openTime);
  const closeTime = Number(existence.closeTime);
  if (!Number.isFinite(openTime) || openTime > now) return null;
  if (Number.isFinite(closeTime) && closeTime <= now) return null;

  return {
    openTime,
    closeTime: Number.isFinite(closeTime) ? closeTime : null
  };
}

function getStagePrefix(stageCodes: readonly string[]): string | null {
  const counts = new Map<string, number>();
  stageCodes.forEach(code => {
    const match = String(code || '').match(/^([A-Z]{2,5})-/i);
    if (!match) return;
    const prefix = match[1].toUpperCase();
    counts.set(prefix, (counts.get(prefix) || 0) + 1);
  });

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0] || null;
}

export function selectCurrentPenguinActivity(
  zones: unknown,
  stages: unknown,
  server = 'CN',
  now = Date.now()
): PenguinActivity | null {
  if (!Array.isArray(zones) || !Array.isArray(stages)) return null;

  const activeZones: { zone: Record<string, unknown>; window: ActivityWindow }[] = [];
  for (const zone of zones) {
    if (!isRecord(zone) || zone.type !== 'ACTIVITY') continue;
    const window = getActiveExistence(zone, server, now);
    if (window) activeZones.push({ zone, window });
  }
  activeZones.sort((left, right) => right.window.openTime - left.window.openTime);

  for (const { zone, window } of activeZones) {
    const stageCodes = stages
      .filter(stage =>
        (isRecord(stage) ? stage.zoneId : undefined) === zone.zoneId &&
        getActiveExistence(stage, server, now)
      )
      .map(stage => String((isRecord(stage) ? stage.code : undefined) || '').trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    const code = getStagePrefix(stageCodes);
    if (!code) continue;

    return {
      code,
      name: readOptionalString(zone.zoneName) ||
        readOptionalString(isRecord(zone.zoneName_i18n) ? zone.zoneName_i18n.zh : undefined) ||
        code,
      source: 'penguin',
      startTime: window.openTime,
      endTime: window.closeTime,
      stages: stageCodes
    };
  }

  return null;
}

async function fetchJson(url: string): Promise<unknown> {
  const { data } = await outboundHttp.requestJson(url);
  return data;
}

export async function getFallbackActivity(
  clientType: string = DEFAULT_CLIENT_TYPE
): Promise<PenguinActivity | null> {
  const server = CLIENT_SERVERS[clientType];
  if (!server) return null;

  const cached = cache.get(server);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.value;
  const inFlight = activeRequests.get(server);
  if (inFlight) return inFlight;

  const request = Promise.all([
    fetchJson(`${PENGUIN_API_BASE}/zones?server=${server}`),
    fetchJson(`${PENGUIN_API_BASE}/stages?server=${server}`)
  ]).then(([zones, stages]) => {
    const value = selectCurrentPenguinActivity(zones, stages, server);
    cache.set(server, { timestamp: Date.now(), value });
    return value;
  }).finally(() => {
    activeRequests.delete(server);
  });

  activeRequests.set(server, request);
  return request;
}
