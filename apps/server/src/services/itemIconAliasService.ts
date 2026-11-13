import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
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

function iconIdFromFileName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const fileName = basename(value);
  const iconId = fileName.toLowerCase().endsWith('.png') ? fileName.slice(0, -4) : fileName;
  return SAFE_ASSET_KEY.test(iconId) ? iconId : null;
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

/**
 * 从 `item_index.json` 载荷建立映射。该文件没有独立 iconId：`icon` 字段是图片
 * 文件名，去掉扩展名后同时充当 iconId 与物品 id 两边的键，供 item_table 缺失时
 * 兜底。缺少可用图标名的条目跳过，从不抛出。
 */
export function parseItemIndexAliasTable(payload: unknown): ItemIconAliasTable {
  if (!isRecord(payload)) return EMPTY_ITEM_ICON_ALIAS_TABLE;

  const byIconId = new Map<string, string[]>();
  const byLowercaseIconId = new Map<string, string[]>();
  const byItemId = new Map<string, string>();

  for (const [itemId, rawEntry] of Object.entries(payload)) {
    if (!SAFE_ASSET_KEY.test(itemId) || !isRecord(rawEntry)) continue;
    const iconId = iconIdFromFileName(rawEntry.icon);
    if (!iconId) continue;
    appendAlias(byIconId, iconId, itemId);
    appendAlias(byLowercaseIconId, iconId.toLowerCase(), itemId);
    if (!byItemId.has(itemId)) byItemId.set(itemId, iconId);
  }

  return { byIconId, byLowercaseIconId, byItemId };
}

async function readAliases<T>(
  filePath: string,
  parse: (payload: unknown) => T,
  failureMessage: string
): Promise<T | null> {
  try {
    return parse(JSON.parse(await readFile(filePath, 'utf8')));
  } catch (error) {
    logger.warn(failureMessage, { path: filePath, error: errorMessage(error) });
    return null;
  }
}

function hasAliases(table: ItemIconAliasTable | null): table is ItemIconAliasTable {
  return table !== null && table.byItemId.size > 0;
}

async function loadAliasTable(
  itemTablePath: string,
  itemIndexPath: string | undefined,
  itemTableSignature: string | null,
  itemIndexSignature: string | null
): Promise<ItemIconAliasTable> {
  if (itemTableSignature !== null) {
    const itemTable = await readAliases(
      itemTablePath,
      parseItemIconAliasTable,
      '物品图标映射读取失败，改用物品索引'
    );
    if (hasAliases(itemTable)) return itemTable;
  }
  if (itemIndexPath && itemIndexSignature !== null) {
    const itemIndex = await readAliases(
      itemIndexPath,
      parseItemIndexAliasTable,
      '物品索引图标映射读取失败，仅按文件名提供图标'
    );
    if (hasAliases(itemIndex)) return itemIndex;
  }
  return EMPTY_ITEM_ICON_ALIAS_TABLE;
}

async function fileSignature(filePath: string): Promise<string | null> {
  const fileStat = await stat(filePath).catch(() => null);
  return fileStat ? `${fileStat.mtimeMs}:${fileStat.size}` : null;
}

/**
 * 读取本地图标别名映射：优先 `item_table.json`，缺失或不可解析时回退到
 * `item_index.json` 的 `icon` 字段（MAA 默认资源只带后者）；两者都不可用时
 * 返回空表，直连文件名仍然可用。读取结果按文件签名的组合缓存，并发图片请求
 * 共享同一次读取，文件变化后自然失效。
 */
export async function loadItemIconAliasTable(
  itemTablePath: string,
  itemIndexPath?: string
): Promise<ItemIconAliasTable> {
  const itemTableSignature = await fileSignature(itemTablePath);
  const itemIndexSignature = itemIndexPath ? await fileSignature(itemIndexPath) : null;
  const cacheKey = itemIndexPath ? `${itemTablePath}\u0000${itemIndexPath}` : itemTablePath;

  if (!itemTableSignature && !itemIndexSignature) {
    aliasCache.delete(cacheKey);
    return EMPTY_ITEM_ICON_ALIAS_TABLE;
  }

  const signature = `${itemTableSignature ?? '-'}|${itemIndexSignature ?? '-'}`;
  const cached = aliasCache.get(cacheKey);
  if (cached?.signature === signature) return cached.table;

  const table = loadAliasTable(itemTablePath, itemIndexPath, itemTableSignature, itemIndexSignature);
  aliasCache.set(cacheKey, { signature, table });
  return table;
}
