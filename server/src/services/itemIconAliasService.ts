import { readFile, stat } from 'node:fs/promises';
import { createLogger } from '../utils/logger.ts';

const logger = createLogger('GameAsset');

const SAFE_ASSET_KEY = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * 物品资源文件名与游戏 `item_table` 字段的双向映射：
 * MAA 资源的 `template/items` 按物品 id 命名，上游图片仓库按 iconId 命名，
 * 两类目录都要能响应客户端请求。重复 iconId 保留全部候选，由解析方逐个尝试。
 */
export interface ItemIconAliasTable {
  byIconId: ReadonlyMap<string, readonly string[]>;
  byLowercaseIconId: ReadonlyMap<string, readonly string[]>;
  byItemId: ReadonlyMap<string, string>;
}

const EMPTY_ITEM_ICON_ALIAS_TABLE: ItemIconAliasTable = {
  byIconId: new Map(),
  byLowercaseIconId: new Map(),
  byItemId: new Map()
};

interface AliasCacheEntry {
  signature: string;
  table: Promise<ItemIconAliasTable>;
}

const aliasCache = new Map<string, AliasCacheEntry>();

/** 仅供测试隔离；生产进程按文件 mtime/size 自然失效，不主动清缓存。 */
export function resetItemIconAliasCacheForTests(): void {
  aliasCache.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendAlias(map: Map<string, string[]>, key: string, itemId: string): void {
  const candidates = map.get(key);
  if (!candidates) {
    map.set(key, [itemId]);
    return;
  }
  if (!candidates.includes(itemId)) candidates.push(itemId);
}

/**
 * 从 `item_table.json` 载荷建立映射：同时保留 iconId→物品 id（优先按物品表顺序、
 * 重复 iconId 为候选列表）与物品 id→iconId。缺少 `items` 或条目无效时跳过，
 * 从不抛出，资源路由不能因元数据格式问题变成 5xx。
 */
export function parseItemIconAliasTable(payload: unknown): ItemIconAliasTable {
  if (!isRecord(payload) || !isRecord(payload.items)) return EMPTY_ITEM_ICON_ALIAS_TABLE;

  const byIconId = new Map<string, string[]>();
  const byLowercaseIconId = new Map<string, string[]>();
  const byItemId = new Map<string, string>();

  for (const [itemId, rawEntry] of Object.entries(payload.items)) {
    if (!SAFE_ASSET_KEY.test(itemId) || !isRecord(rawEntry)) continue;
    const iconId = rawEntry.iconId;
    if (typeof iconId !== 'string' || !SAFE_ASSET_KEY.test(iconId)) continue;
    appendAlias(byIconId, iconId, itemId);
    appendAlias(byLowercaseIconId, iconId.toLowerCase(), itemId);
    if (!byItemId.has(itemId)) byItemId.set(itemId, iconId);
  }

  return { byIconId, byLowercaseIconId, byItemId };
}

async function readItemIconAliasTable(itemTablePath: string): Promise<ItemIconAliasTable> {
  try {
    return parseItemIconAliasTable(JSON.parse(await readFile(itemTablePath, 'utf8')));
  } catch (error) {
    logger.warn('物品图标映射读取失败，仅按文件名提供图标', {
      path: itemTablePath,
      error: errorMessage(error)
    });
    return EMPTY_ITEM_ICON_ALIAS_TABLE;
  }
}

/**
 * 读取本地 `item_table.json` 建立图标别名映射。文件缺失时静默返回空表（直连文件名
 * 仍然可用）；读取或解析失败按文件签名缓存空表，避免并发图片请求重复读取与刷日志。
 */
export async function loadItemIconAliasTable(itemTablePath: string): Promise<ItemIconAliasTable> {
  const fileStat = await stat(itemTablePath).catch(() => null);
  if (!fileStat) {
    aliasCache.delete(itemTablePath);
    return EMPTY_ITEM_ICON_ALIAS_TABLE;
  }

  const signature = `${fileStat.mtimeMs}:${fileStat.size}`;
  const cached = aliasCache.get(itemTablePath);
  if (cached?.signature === signature) return cached.table;

  const table = readItemIconAliasTable(itemTablePath);
  aliasCache.set(itemTablePath, { signature, table });
  return table;
}
