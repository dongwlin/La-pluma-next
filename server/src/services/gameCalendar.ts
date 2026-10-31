/**
 * 游戏日与客户端服务区时区
 *
 * 所有“今日”判断按客户端所属服务区的游戏日计算：服务区时区 + 每日 04:00
 * 日界。上游以 `utcOffsetHours - 4` 的固定偏移折算游戏日；本模块只读取折算后
 * 时间戳的 UTC 分量，因此与宿主进程时区、夏令时无关。
 *
 * 纯函数、零依赖：客户端类型到服务区的映射与日界换算集中在这里；关卡周表
 * 仍归 notificationService，cron 触发时区由调度注册表消费本模块的输出。
 * 默认客户端类型不写进本模块，由调用方显式传入，避免测试受进程环境影响。
 */

/** 游戏日刷新时刻：服务区当地时间每日 04:00 进入下一个游戏日。 */
export const GAME_DAY_START_HOUR = 4;

const HOUR_MS = 3_600_000;

/** 服务区：规范化客户端类型、相对 UTC 的固定偏移与 cron 使用的 IANA 时区。 */
export interface GameZone {
  /** 规范化后的客户端类型键；未知或空值回落到 Official。 */
  clientType: string;
  /** 服务区相对 UTC 的固定偏移（小时）。 */
  utcOffsetHours: number;
  /** 服务区对应的 IANA 时区名，用于调度注册。 */
  timeZone: string;
}

/** 游戏日：`YYYY-MM-DD` 与服务区星期（0=周日 … 6=周六）。 */
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

/** 把客户端类型解析为服务区；未知或空值回落 Official。 */
export function resolveGameZone(clientType?: string | null): GameZone {
  const key = typeof clientType === 'string' ? clientType.trim().toLowerCase() : '';
  return GAME_ZONES[key] ?? GAME_ZONES.official;
}

/** 客户端类型对应的 IANA 时区；未知值回落 Official 时区。 */
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
