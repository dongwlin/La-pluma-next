import { realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { loadItemIconAliasTable } from './itemIconAliasService.ts';
import type { ItemIconAliasTable } from './itemIconAliasService.ts';

export const GAME_ASSET_ROUTE_PREFIX = '/game-assets';

export const GAME_ASSET_KINDS = ['item', 'avatar'] as const;
export type GameAssetKind = (typeof GAME_ASSET_KINDS)[number];

const GAME_ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
};

export const GAME_ASSET_EXTENSIONS = Object.keys(GAME_ASSET_CONTENT_TYPES) as readonly string[];

export interface GameAssetFile {
  filePath: string;
  contentType: string;
}

export interface ResolveGameAssetOptions {
  kindDir: string;
  fileName: string;
}

export interface ResolveItemAssetOptions {
  itemDir: string;
  fileName: string;
  itemTablePath: string;
}

export function isGameAssetKind(value: string): value is GameAssetKind {
  return (GAME_ASSET_KINDS as readonly string[]).includes(value);
}

export function gameAssetContentType(fileName: string): string | null {
  const extension = extname(fileName).toLowerCase();
  return GAME_ASSET_CONTENT_TYPES[extension] ?? null;
}

function isSafeFileName(fileName: string): boolean {
  if (!fileName || fileName.length > 200) return false;
  if (fileName.startsWith('.') || fileName !== basename(fileName)) return false;
  return !/[/\\\u0000-\u001f\u007f]/.test(fileName);
}

interface GameAssetRequest {
  fileName: string;
  stem: string;
  extension: string;
}

function parseGameAssetRequest(fileName: string): GameAssetRequest | null {
  if (!gameAssetContentType(fileName) || !isSafeFileName(fileName)) return null;
  const extension = extname(fileName).toLowerCase();
  return { fileName, stem: fileName.slice(0, fileName.length - extension.length), extension };
}

function isDirectChild(rootDir: string, filePath: string): boolean {
  const child = relative(rootDir, filePath);
  return Boolean(child) && !child.startsWith('..') && !isAbsolute(child) && !child.includes(sep);
}

async function resolveExistingAssetFile(kindDir: string, fileName: string): Promise<GameAssetFile | null> {
  const kindRoot = await realpath(kindDir).catch(() => null);
  if (!kindRoot) return null;

  const filePath = await realpath(resolve(kindDir, fileName)).catch(() => null);
  if (!filePath || !isDirectChild(kindRoot, filePath)) return null;

  const fileStats = await stat(filePath).catch(() => null);
  if (!fileStats?.isFile()) return null;

  const contentType = gameAssetContentType(filePath);
  return contentType ? { filePath, contentType } : null;
}

function* findItemIconAliases(table: ItemIconAliasTable, key: string): Generator<string> {
  const itemIds = table.byIconId.get(key) ?? table.byLowercaseIconId.get(key.toLowerCase());
  if (itemIds) yield* itemIds;
  const iconId = table.byItemId.get(key);
  if (iconId) yield iconId;
}

/**
 * 把请求中的资源文件名解析为可发送的本地文件。
 * 只允许类型目录的直接子文件、白名单扩展名与真实路径仍位于该目录内；
 * 任何越界、目录、符号链接逃逸或缺失文件都返回 null，不向调用方暴露原因。
 */
export async function resolveGameAssetFile(options: ResolveGameAssetOptions): Promise<GameAssetFile | null> {
  const request = parseGameAssetRequest(options.fileName);
  if (!request) return null;
  return resolveExistingAssetFile(options.kindDir, request.fileName);
}

/**
 * 物品图标的解析入口：先按请求键直连，再借助本地 `item_table` 在 iconId 与物品 id
 * 之间互查。MAA 资源按物品 id 命名图标，兼容目录可能按 iconId 命名；映射缺失时
 * 只退化为直连，不把图片请求变成失败响应。
 */
export async function resolveItemAssetFile(options: ResolveItemAssetOptions): Promise<GameAssetFile | null> {
  const request = parseGameAssetRequest(options.fileName);
  if (!request) return null;

  const direct = await resolveExistingAssetFile(options.itemDir, request.fileName);
  if (direct) return direct;

  const aliases = await loadItemIconAliasTable(options.itemTablePath);
  for (const candidateKey of findItemIconAliases(aliases, request.stem)) {
    const candidateName = `${candidateKey}${request.extension}`;
    if (!isSafeFileName(candidateName)) continue;
    const asset = await resolveExistingAssetFile(options.itemDir, candidateName);
    if (asset) return asset;
  }
  return null;
}

