import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  const dataDir = options.dataDir ?? resolveAppPaths().appDataDir;
  const importDir = join(dataDir, COPILOT_FILE_IMPORT_DIR);
  await ensureDir(importDir);
  const filePath = join(importDir, `${randomUUID()}.json`);
  await writeFile(filePath, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  return { path: filePath, name, bytes };
}
