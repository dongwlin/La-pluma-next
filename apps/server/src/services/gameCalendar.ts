export const GAME_DAY_START_HOUR = 4;

const HOUR_MS = 3_600_000;

export interface GameZone {
  clientType: string;
  utcOffsetHours: number;
  timeZone: string;
}

export interface GameDay {
  date: string;
  weekday: number;
}

// 键按小写匹配：`txwy` 在 profile 中可能是 Txwy/txwy，映射必须大小写不敏感。
// IANA 的 Etc/GMT+7 语义取反，表示 UTC-7。
const GAME_ZONES: Record<string, GameZone> = {
  official: { clientType: 'Official', utcOffsetHours: 8, timeZone: 'Asia/Shanghai' },
  bilibili: { clientType: 'Bilibili', utcOffsetHours: 8, timeZone: 'Asia/Shanghai' },
  txwy: { clientType: 'txwy', utcOffsetHours: 8, timeZone: 'Asia/Shanghai' },
  yostaren: { clientType: 'YoStarEN', utcOffsetHours: -7, timeZone: 'Etc/GMT+7' },
  yostarjp: { clientType: 'YoStarJP', utcOffsetHours: 9, timeZone: 'Asia/Tokyo' },
  yostarkr: { clientType: 'YoStarKR', utcOffsetHours: 9, timeZone: 'Asia/Seoul' }
};

export function resolveGameZone(clientType?: string | null): GameZone {
  const key = typeof clientType === 'string' ? clientType.trim().toLowerCase() : '';
  return GAME_ZONES[key] ?? GAME_ZONES.official;
}

export function gameTimeZoneForClientType(clientType?: string | null): string {
  return resolveGameZone(clientType).timeZone;
}

/**
 * 计算 `now` 时刻所属的游戏日。
 *
 * 先把时刻平移到“服务区当地时间减去 04:00”的时间轴，再取 UTC 日期与星期；
 * 这一步只做固定小时偏移，不受宿主时区或夏令时影响。
 */
export function getGameDay(now: Date, clientType?: string | null): GameDay {
  const { utcOffsetHours } = resolveGameZone(clientType);
  const shifted = new Date(now.getTime() + (utcOffsetHours - GAME_DAY_START_HOUR) * HOUR_MS);
  return {
    date: shifted.toISOString().slice(0, 10),
    weekday: shifted.getUTCDay()
  };
}
