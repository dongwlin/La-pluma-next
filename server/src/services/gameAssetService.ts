import { realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
  rootDir: string;
  kind: GameAssetKind;
  fileName: string;
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

function isDirectChild(rootDir: string, filePath: string): boolean {
  const child = relative(rootDir, filePath);
  return Boolean(child) && !child.startsWith('..') && !isAbsolute(child) && !child.includes(sep);
}

/**
 * 把请求中的资源类型与文件名解析为可发送的本地文件。
 * 只允许根目录直接子文件、白名单扩展名与真实路径仍位于类型目录内；
 * 任何越界、目录、符号链接逃逸或缺失文件都返回 null，不向调用方暴露原因。
 */
export async function resolveGameAssetFile(options: ResolveGameAssetOptions): Promise<GameAssetFile | null> {
  if (!gameAssetContentType(options.fileName) || !isSafeFileName(options.fileName)) return null;

  const kindDir = join(options.rootDir, options.kind);
  const rootDir = await realpath(kindDir).catch(() => null);
  if (!rootDir) return null;

  const requestedPath = resolve(kindDir, options.fileName);
  const filePath = await realpath(requestedPath).catch(() => null);
  if (!filePath || !isDirectChild(rootDir, filePath)) return null;

  const fileStats = await stat(filePath).catch(() => null);
  if (!fileStats?.isFile()) return null;

  const contentType = gameAssetContentType(filePath);
  return contentType ? { filePath, contentType } : null;
}
