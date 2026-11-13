import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { resolveAppPaths } from '../config/runtimeConfig.ts';
import { ensureDir } from '../utils/fileHelper.ts';

export const COPILOT_FILE_MAX_BYTES = 2 * 1024 * 1024;
export const COPILOT_FILE_IMPORT_DIR = 'copilot-imports';
export const DEFAULT_COPILOT_FILE_NAME = 'copilot.json';

export type CopilotFileInvalidReason =
  | 'body_not_object'
  | 'content_not_string'
  | 'content_too_large'
  | 'content_invalid_json'
  | 'content_not_object'
  | 'stage_name_invalid';

export class CopilotFileInvalidError extends Error {
  readonly reason: CopilotFileInvalidReason;

  constructor(reason: CopilotFileInvalidReason, message: string) {
    super(message);
    this.name = 'CopilotFileInvalidError';
    this.reason = reason;
  }
}

export type CopilotManagedFileInvalidReason =
  | CopilotFileInvalidReason
  | 'filename_invalid'
  | 'filename_not_absolute'
  | 'filename_extension_invalid'
  | 'filename_traversal'
  | 'filename_outside_import_dir'
  | 'file_missing'
  | 'file_not_regular'
  | 'file_too_large';

export class CopilotManagedFileInvalidError extends Error {
  readonly reason: CopilotManagedFileInvalidReason;

  constructor(reason: CopilotManagedFileInvalidReason, message: string) {
    super(message);
    this.name = 'CopilotManagedFileInvalidError';
    this.reason = reason;
  }
}

export interface CopilotFileInput {
  name?: unknown;
  content?: unknown;
}

export interface CopilotFileResult {
  path: string;
  name: string;
  bytes: number;
}

export interface CopilotFileSaveOptions {
  dataDir?: string;
}

export interface CopilotManagedFileReadOptions {
  dataDir?: string;
}

export interface CopilotManagedFile {
  path: string;
  content: Record<string, unknown>;
  stageName: string;
  bytes: number;
}

const UNSAFE_NAME_CHARS = /[^\p{L}\p{N}._-]+/gu;
const NAME_EDGE_SEPARATORS = /^[._-]+|[._-]+$/gu;
const JSON_EXTENSION = '.json';
const FALLBACK_NAME_BASE = 'copilot';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sanitizeCopilotFileName(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_COPILOT_FILE_NAME;
  const leaf = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = leaf.replace(UNSAFE_NAME_CHARS, '_').replace(NAME_EDGE_SEPARATORS, '');
  if (!cleaned) return DEFAULT_COPILOT_FILE_NAME;
  const base = cleaned.toLowerCase().endsWith(JSON_EXTENSION)
    ? cleaned.slice(0, -JSON_EXTENSION.length)
    : cleaned;
  return `${base || FALLBACK_NAME_BASE}${JSON_EXTENSION}`;
}

function readBodyRecord(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new CopilotFileInvalidError('body_not_object', '请求体必须是 JSON 对象');
  }
  return body;
}

function readContent(body: Record<string, unknown>): string {
  if (typeof body.content !== 'string') {
    throw new CopilotFileInvalidError('content_not_string', '作业文件内容必须是字符串');
  }
  return body.content;
}

function parseCopilotJson(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new CopilotFileInvalidError('content_invalid_json', '作业文件不是有效的 JSON');
  }
  if (!isRecord(parsed)) {
    throw new CopilotFileInvalidError('content_not_object', '作业文件必须是 JSON 对象');
  }
  return parsed;
}

function requireStageName(payload: Record<string, unknown>): void {
  const stageName = payload.stage_name;
  if (typeof stageName !== 'string' || stageName.trim() === '') {
    throw new CopilotFileInvalidError('stage_name_invalid', '作业文件缺少有效的 stage_name');
  }
}

function resolveImportDir(dataDir?: string): string {
  return join(dataDir ?? resolveAppPaths().appDataDir, COPILOT_FILE_IMPORT_DIR);
}

function isOutsideImportDir(importDir: string, target: string): boolean {
  const relativePath = relative(importDir, target);
  return !relativePath || relativePath.startsWith('..') || isAbsolute(relativePath);
}

function resolveManagedCopilotFile(
  raw: unknown,
  options: CopilotManagedFileReadOptions
): { filename: string; filePath: string; importDir: string } {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new CopilotManagedFileInvalidError('filename_invalid', '作业文件路径必须是非空字符串');
  }
  const filename = raw.trim();
  if (!isAbsolute(filename)) {
    throw new CopilotManagedFileInvalidError('filename_not_absolute', '作业文件必须使用绝对路径');
  }
  if (filename.split(/[\\/]/).includes('..')) {
    throw new CopilotManagedFileInvalidError('filename_traversal', '作业文件路径不能包含上级目录');
  }
  if (!filename.toLowerCase().endsWith(JSON_EXTENSION)) {
    throw new CopilotManagedFileInvalidError('filename_extension_invalid', '作业文件必须是 .json 文件');
  }
  const importDir = resolveImportDir(options.dataDir);
  const resolvedFilename = resolve(filename);
  if (!isOutsideImportDir(importDir, resolvedFilename)) return { filename, filePath: filename, importDir };
  if (options.dataDir === undefined) {
    const { serverRoot } = resolveAppPaths();
    const legacyImportDir = resolve(serverRoot, '../..', 'server', 'data', COPILOT_FILE_IMPORT_DIR);
    if (!isOutsideImportDir(legacyImportDir, resolvedFilename)) {
      return { filename, filePath: join(importDir, relative(legacyImportDir, resolvedFilename)), importDir };
    }
  }
  throw new CopilotManagedFileInvalidError(
    'filename_outside_import_dir',
    `作业文件必须位于受管目录 ${COPILOT_FILE_IMPORT_DIR} 内`
  );
}

export function validateManagedCopilotFileName(
  raw: unknown,
  options: CopilotManagedFileReadOptions = {}
): string {
  return resolveManagedCopilotFile(raw, options).filename;
}

function parseManagedCopilotContent(text: string): {
  content: Record<string, unknown>;
  stageName: string;
} {
  try {
    const content = parseCopilotJson(text);
    requireStageName(content);
    return { content, stageName: String(content.stage_name).trim() };
  } catch (error) {
    if (error instanceof CopilotFileInvalidError) {
      throw new CopilotManagedFileInvalidError(error.reason, error.message);
    }
    throw error;
  }
}

export async function readManagedCopilotFile(
  raw: unknown,
  options: CopilotManagedFileReadOptions = {}
): Promise<CopilotManagedFile> {
  const { filePath, importDir } = resolveManagedCopilotFile(raw, options);
  let importRoot: string;
  try {
    importRoot = await realpath(importDir);
  } catch {
    throw new CopilotManagedFileInvalidError('file_missing', '作业文件不存在');
  }
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(filePath);
  } catch {
    throw new CopilotManagedFileInvalidError('file_missing', '作业文件不存在');
  }
  if (isOutsideImportDir(importRoot, resolvedPath)) {
    throw new CopilotManagedFileInvalidError(
      'filename_outside_import_dir',
      `作业文件必须位于受管目录 ${COPILOT_FILE_IMPORT_DIR} 内`
    );
  }
  const info = await stat(resolvedPath);
  if (!info.isFile()) {
    throw new CopilotManagedFileInvalidError('file_not_regular', '作业文件必须是普通文件');
  }
  if (info.size > COPILOT_FILE_MAX_BYTES) {
    throw new CopilotManagedFileInvalidError(
      'file_too_large',
      `作业文件不能超过 ${COPILOT_FILE_MAX_BYTES} 字节`
    );
  }
  const { content, stageName } = parseManagedCopilotContent(await readFile(resolvedPath, 'utf8'));
  return { path: resolvedPath, content, stageName, bytes: info.size };
}

export async function saveCopilotFile(
  input: unknown,
  options: CopilotFileSaveOptions = {}
): Promise<CopilotFileResult> {
  const body = readBodyRecord(input);
  const content = readContent(body);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > COPILOT_FILE_MAX_BYTES) {
    throw new CopilotFileInvalidError(
      'content_too_large',
      `作业文件内容不能超过 ${COPILOT_FILE_MAX_BYTES} 字节`
    );
  }
  requireStageName(parseCopilotJson(content));
  const name = sanitizeCopilotFileName(body.name);
  const importDir = resolveImportDir(options.dataDir);
  await ensureDir(importDir);
  const filePath = join(importDir, `${randomUUID()}.json`);
  await writeFile(filePath, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  return { path: filePath, name, bytes };
}
