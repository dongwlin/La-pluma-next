import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAppPaths } from '../src/config/runtimeConfig.ts';

export type JsonRecord = Record<string, unknown>;

export function resolveTrainingDataPath(fileName: string): string {
  return join(resolveAppPaths().trainingDataDir, fileName);
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isDirectExecution(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  return typeof entry === 'string' && resolve(entry) === fileURLToPath(importMetaUrl);
}

export function invalidPayload(source: string, detail: string): Error {
  return new Error(`${source} 数据格式无效: ${detail}`);
}

export function expectRecord(value: unknown, source: string, label = '根节点'): JsonRecord {
  if (!isRecord(value)) throw invalidPayload(source, `${label}应为对象`);
  return value;
}

export function expectArray(value: unknown, source: string, label: string): unknown[] {
  if (!Array.isArray(value)) throw invalidPayload(source, `${label}应为数组`);
  return value;
}

/** 读取可选对象：null 与缺失按不存在处理，与既有 `x || {}` 语义一致。 */
export function optionalRecord(value: unknown, source: string, label: string): JsonRecord | undefined {
  if (value === undefined || value === null) return undefined;
  return expectRecord(value, source, label);
}

/** 读取可选数组：null 与缺失按不存在处理，与既有 `x || []` 语义一致。 */
export function optionalArray(value: unknown, source: string, label: string): unknown[] | undefined {
  if (value === undefined || value === null) return undefined;
  return expectArray(value, source, label);
}

export function expectString(value: unknown, source: string, label: string): string {
  if (typeof value !== 'string') throw invalidPayload(source, `${label}应为字符串`);
  return value;
}

export function expectNumber(value: unknown, source: string, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidPayload(source, `${label}应为有限数字`);
  }
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
