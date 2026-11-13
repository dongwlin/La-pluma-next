import { realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { GAME_ASSET_DIR_ENV, resolveGameAssetPaths } from '../config/gameAssetPaths.ts';
import { resolveMaaPaths } from '../config/paths.ts';
import type { RuntimeEnvSource } from '../config/runtimeConfig.ts';
import { loadItemIconAliasTable } from './itemIconAliasService.ts';
import type { ItemIconAliasTable } from './itemIconAliasService.ts';
import { getEffectiveResourceDirs, resolveEffectiveResourceFilePath } from './resourceUpdateService.ts';

export const GAME_ASSET_ROUTE_PREFIX = '/game-assets';

/**
 * 资源命名空间判定。Express 的挂载匹配默认忽略大小写，同源响应头与路由必须
 * 使用同一规则，否则大小写变体会落回 CORS 分支而绕过同源边界。
 */
export function isGameAssetRequestPath(requestPath: string): boolean {
  const normalized = requestPath.toLowerCase();
  return normalized === GAME_ASSET_ROUTE_PREFIX
    || normalized.startsWith(`${GAME_ASSET_ROUTE_PREFIX}/`);
}

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
  kindDirs: readonly string[];
  fileName: string;
}

export interface ResolveItemAssetOptions {
  itemDirs: readonly string[];
  fileName: string;
  itemTablePath: string;
  itemIndexPath?: string;
}

/** 一次图片请求解析出的资源目录与别名映射文件路径；目录按生效优先排序。 */
export interface GameAssetDirs {
  itemDirs: string[];
  avatarDirs: string[];
  itemTablePath: string;
  itemIndexPath: string;
}

export interface GameAssetDirsOptions {
  env?: RuntimeEnvSource;
}

/**
 * 图片路由的目录来源：显式 `LA_PLUMA_GAME_ASSET_DIR` 独占生效（目录布局与上游
 * 资源仓库一致）；否则对每个候选资源层取 `template/` 子目录，排序与 MaaCore 的
 * 资源覆盖顺序相反（后加载者优先）。别名映射的 item_table/item_index 按
 * 共享解析取生效版本。
 */
export function createGameAssetDirsProvider(options: GameAssetDirsOptions = {}): () => Promise<GameAssetDirs> {
  const env = options.env ?? process.env;
  return async () => {
    if (env[GAME_ASSET_DIR_ENV]?.trim()) {
      const explicit = resolveGameAssetPaths({ env });
      const maaPaths = resolveMaaPaths({ env });
      return {
        itemDirs: [explicit.itemDir],
        avatarDirs: [explicit.avatarDir],
        itemTablePath: maaPaths.itemTablePath,
        itemIndexPath: maaPaths.itemIndexPath
      };
    }

    const dirs = await getEffectiveResourceDirs({ env });
    const templates = [...dirs].reverse().map(dir => join(dir, 'template'));
    const [itemTablePath, itemIndexPath] = await Promise.all([
      resolveEffectiveResourceFilePath(join('gamedata', 'excel', 'item_table.json'), { env }),
      resolveEffectiveResourceFilePath('item_index.json', { env })
    ]);
    return {
      itemDirs: templates.map(dir => join(dir, 'items')),
      avatarDirs: templates.map(dir => join(dir, 'avatar')),
      itemTablePath,
      itemIndexPath
    };
  };
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

async function resolveExistingAssetFile(kindDirs: readonly string[], fileName: string): Promise<GameAssetFile | null> {
  for (const kindDir of kindDirs) {
    const kindRoot = await realpath(kindDir).catch(() => null);
    if (!kindRoot) continue;

    const filePath = await realpath(resolve(kindDir, fileName)).catch(() => null);
    if (!filePath || !isDirectChild(kindRoot, filePath)) continue;

    const fileStats = await stat(filePath).catch(() => null);
    if (!fileStats?.isFile()) continue;

    const contentType = gameAssetContentType(filePath);
    if (contentType) return { filePath, contentType };
  }
  return null;
}

function* findItemIconAliases(table: ItemIconAliasTable, key: string): Generator<string> {
  const itemIds = table.byIconId.get(key) ?? table.byLowercaseIconId.get(key.toLowerCase());
  if (itemIds) yield* itemIds;
  const iconId = table.byItemId.get(key);
  if (iconId) yield iconId;
}

/**
 * 把请求中的资源文件名解析为可发送的本地文件。
 * 目录按生效优先排序，逐目录取第一个命中的文件；只允许类型目录的直接子文件、
 * 白名单扩展名与真实路径仍位于该目录内；任何越界、目录、符号链接逃逸或缺失
 * 文件都返回 null，不向调用方暴露原因。
 */
export async function resolveGameAssetFile(options: ResolveGameAssetOptions): Promise<GameAssetFile | null> {
  const request = parseGameAssetRequest(options.fileName);
  if (!request) return null;
  return resolveExistingAssetFile(options.kindDirs, request.fileName);
}

/**
 * 物品图标的解析入口：先按请求键直连，再借助本地 `item_table`（缺失时用
 * `item_index`）在 iconId 与物品 id 之间互查。MAA 资源按物品 id 命名图标，
 * 兼容目录可能按 iconId 命名；映射缺失时只退化为直连，不把图片请求变成失败响应。
 */
export async function resolveItemAssetFile(options: ResolveItemAssetOptions): Promise<GameAssetFile | null> {
  const request = parseGameAssetRequest(options.fileName);
  if (!request) return null;

  const direct = await resolveExistingAssetFile(options.itemDirs, request.fileName);
  if (direct) return direct;

  const aliases = await loadItemIconAliasTable(options.itemTablePath, options.itemIndexPath);
  for (const candidateKey of findItemIconAliases(aliases, request.stem)) {
    const candidateName = `${candidateKey}${request.extension}`;
    if (!isSafeFileName(candidateName)) continue;
    const asset = await resolveExistingAssetFile(options.itemDirs, candidateName);
    if (asset) return asset;
  }
  return null;
}

