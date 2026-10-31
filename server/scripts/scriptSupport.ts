/**
 * 维护脚本共享的运行时与外部载荷校验工具。
 *
 * 维护脚本既可直接运行（`node scripts/<name>.ts`），也可被测试导入：
 * 只有作为入口运行时才触发抓取或写入，导入本身不产生副作用。
 */

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAppPaths } from '../src/config/runtimeConfig.ts';

/** 已解析的 JSON 对象。 */
export type JsonRecord = Record<string, unknown>;

/**
 * 参考数据输出路径：与养成服务共用 `resolveAppPaths().trainingDataDir`，
 * 默认 `server/data`，可由 `LA_PLUMA_TRAINING_DATA_DIR` 重定向。
 */
export function resolveTrainingDataPath(fileName: string): string {
  return join(resolveAppPaths().trainingDataDir, fileName);
}

/** 判断值是否为非数组的 JSON 对象。 */
export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 判断模块是否作为入口脚本直接运行，而不是被测试或其他模块导入。 */
export function isDirectExecution(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  return typeof entry === 'string' && resolve(entry) === fileURLToPath(importMetaUrl);
}

/** 构造带数据源标签的载荷校验错误。 */
export function invalidPayload(source: string, detail: string): Error {
  return new Error(`${source} 数据格式无效: ${detail}`);
}

/** 校验外部载荷为对象。 */
export function expectRecord(value: unknown, source: string, label = '根节点'): JsonRecord {
  if (!isRecord(value)) throw invalidPayload(source, `${label}应为对象`);
  return value;
}

/** 校验外部载荷为数组。 */
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

/** 校验外部载荷为字符串。 */
export function expectString(value: unknown, source: string, label: string): string {
  if (typeof value !== 'string') throw invalidPayload(source, `${label}应为字符串`);
  return value;
}

/** 校验外部载荷为有限数字。 */
export function expectNumber(value: unknown, source: string, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidPayload(source, `${label}应为有限数字`);
  }
  return value;
}

/** 读取可选的字符串字段，其他类型按缺失处理。 */
export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 读取可选的有限数字字段，其他类型按缺失处理。 */
export function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 将未知错误统一转换为消息文本。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
