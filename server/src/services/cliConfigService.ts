/**
 * `cli.toml` 读写的单一入口：路径由 `maa dir config` 解析并要求绝对目录，仅文件
 * 缺失时读取回退空文档；更新沿 `updateTextFile` 的按路径排队与文本原子替换，避免
 * 不同 section 的写入互相覆盖。调用方只负责自己 section 的语义与校验。
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import TOML from '@iarna/toml';
import { updateTextFile } from '../utils/fileHelper.ts';
import { getMaaConfigDir } from './maaConfigService.ts';

export type CliConfigDocument = Record<string, unknown>;

const parseToml: (text: string) => CliConfigDocument = TOML.parse;
const stringifyToml = TOML.stringify as (document: CliConfigDocument) => string;

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function isCliConfigRecord(value: unknown): value is CliConfigDocument {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解析 cli.toml 文本；非法 TOML 或非表文档抛出，不把损坏配置当成空文档。 */
export function parseCliConfigText(content: string): CliConfigDocument {
  const parsed: unknown = parseToml(content);
  if (!isCliConfigRecord(parsed)) throw new TypeError('cli.toml 格式不合法');
  return parsed;
}

export async function resolveCliConfigPath(): Promise<string> {
  const configDir = (await getMaaConfigDir()).trim();
  if (!configDir) throw new Error('无法解析 MAA 配置目录：maa dir config 返回空路径');
  if (!isAbsolute(configDir)) throw new Error(`MAA 配置目录必须是绝对路径: ${configDir}`);
  return resolve(configDir, 'cli.toml');
}

/** 读取 cli.toml；仅文件缺失回退空文档，其它读取失败与非法 TOML 一律抛出。 */
export async function readCliConfigDocument(): Promise<CliConfigDocument> {
  const path = await resolveCliConfigPath();
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw error;
  }
  return parseCliConfigText(content);
}

/**
 * 读改写 cli.toml：更新函数收到最新文档并返回新文档；解析或写入失败时不写回，
 * 已有配置保持原样。
 */
export async function updateCliConfigDocument(
  updateFn: (document: CliConfigDocument) => CliConfigDocument
): Promise<void> {
  const path = await resolveCliConfigPath();
  await updateTextFile(path, current => {
    const document = current === null ? {} : parseCliConfigText(current);
    return stringifyToml(updateFn(document));
  });
}
