/**
 * 从企鹅物流（penguin-stats.io）获取真实掉落统计数据
 *
 * 数据源：企鹅物流公开 API v2（无需鉴权，与 maa-cli --report-to-penguin 的上报渠道同源）
 * - /PenguinStats/api/v2/stages  关卡表：stageId、游戏内代号 code、理智消耗 apCost、所属章节
 * - /PenguinStats/api/v2/result/matrix  掉落矩阵：每关每物品的样本次数与总掉落数
 * - /PenguinStats/api/v2/zones  章节表：用于给关卡标记章节类型（主线/资源/别传等）
 *
 * 输出 server/data/penguin-drop-data.json：
 * - stages：stageId -> { code, apCost, zoneId, zoneType }
 * - dropMatrix：物品Id -> 该物品在各关卡的 { stageId, expected 期望掉落/次, samples 样本数 }（按样本数降序）
 *
 * 注意：企鹅物流矩阵只保留当前可刷关卡的数据，限时活动关过期后条目即被移除，
 * 因此矩阵条目本身就是「该关现在可刷」的过滤器，无需额外维护活动开放期数据。
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  errorMessage,
  expectArray,
  expectNumber,
  expectRecord,
  expectString,
  isDirectExecution,
  optionalArray,
  optionalRecord,
  optionalString
} from './scriptSupport.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PENGUIN_API_BASE = 'https://penguin-stats.io/PenguinStats/api/v2';
const SERVER = 'CN';
const STAGE_SOURCE = 'PenguinStats/stages';
const MATRIX_SOURCE = 'PenguinStats/result/matrix';
const ZONE_SOURCE = 'PenguinStats/zones';

/** 输出目标：penguin-drop-data.json。 */
export const OUTPUT_PATH = join(__dirname, '../data/penguin-drop-data.json');

const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent': 'LaPlumaNext/1.0 (https://github.com/dongwlin/La-pluma-next)',
  'Accept': 'application/json'
};

/** 关卡信息。 */
export interface PenguinStageInfo {
  code: string;
  apCost: number;
  zoneId?: string;
  zoneType: string;
}

/** 单条掉落统计。 */
export interface PenguinDropEntry {
  stageId: string;
  expected: number;
  samples: number;
}

/** penguin-drop-data.json 的完整结构。 */
export interface PenguinDropData {
  metadata: {
    source: string;
    server: string;
    fetchedAt: string;
    stageCount: number;
    itemCovered: number;
    matrixEntryCount: number;
  };
  stages: Record<string, PenguinStageInfo>;
  dropMatrix: Record<string, PenguinDropEntry[]>;
}

/** 从 URL 获取 JSON 数据。 */
async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: REQUEST_HEADERS });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} while fetching ${url}`);
  }
  return response.json();
}

/**
 * 解析章节表：zoneId -> 章节类型。
 */
export function parseZoneTypes(payload: unknown): Map<string, string> {
  const zoneList = expectArray(payload, ZONE_SOURCE, '章节列表');
  const zoneTypes = new Map<string, string>();
  for (const [index, raw] of zoneList.entries()) {
    const zone = expectRecord(raw, ZONE_SOURCE, `章节[${index}]`);
    const zoneId = optionalString(zone.zoneId);
    if (!zoneId) continue;
    zoneTypes.set(zoneId, optionalString(zone.type) ?? 'UNKNOWN');
  }
  return zoneTypes;
}

/**
 * 解析关卡表：跳过无代号或无理智消耗的关卡（剧情关、教学关等不可刷关卡）
 * 以及磨难难度关（tough_*）：磨难与普通关显示代号相同（如 10-2），
 * 但 maa fight 只会跑普通难度，磨难关的掉落统计不能混入选关
 */
export function parseStages(stageListPayload: unknown, zoneTypes: ReadonlyMap<string, string>): Record<string, PenguinStageInfo> {
  const stageList = expectArray(stageListPayload, STAGE_SOURCE, '关卡列表');
  const stages: Record<string, PenguinStageInfo> = {};

  for (const [index, raw] of stageList.entries()) {
    const stage = expectRecord(raw, STAGE_SOURCE, `关卡[${index}]`);
    const stageId = optionalString(stage.stageId);
    const code = optionalString(stage.code);
    const apCost = typeof stage.apCost === 'number' ? stage.apCost : undefined;

    if (!stageId || !code || apCost === undefined || apCost <= 0) continue;
    if (stageId.startsWith('tough_')) continue;

    const existence = optionalRecord(stage.existence, STAGE_SOURCE, `关卡 ${stageId} 的 existence`);
    const cnExistence = optionalRecord(existence?.CN, STAGE_SOURCE, `关卡 ${stageId} 的 existence.CN`);
    if (cnExistence && cnExistence.exist === false) continue;

    const zoneId = optionalString(stage.zoneId);
    stages[stageId] = {
      code,
      apCost,
      ...(zoneId === undefined ? {} : { zoneId }),
      zoneType: zoneTypes.get(zoneId ?? '') || 'UNKNOWN'
    };
  }

  return stages;
}

/**
 * 构建按物品聚合的掉落矩阵：
 * 同一 (stageId, itemId) 可能有多段统计窗口（活动复刻等），按 qty/time 加权合并
 */
export function buildDropMatrix(matrixPayload: unknown): { dropMatrix: Record<string, PenguinDropEntry[]>; entryCount: number } {
  const matrix = expectRecord(matrixPayload, MATRIX_SOURCE);
  const entries = optionalArray(matrix.matrix, MATRIX_SOURCE, 'matrix') ?? [];

  const totals: Record<string, { stageId: string; quantity: number; times: number }[]> = {};

  for (const [index, raw] of entries.entries()) {
    const entry = expectRecord(raw, MATRIX_SOURCE, `matrix[${index}]`);
    const itemId = optionalString(entry.itemId);

    // 物品 Id 仅保留数字型（材料/理智/家具等），排除 furni、randomMaterial_x 等虚拟条目
    if (!itemId || !/^\d+$/.test(itemId)) continue;

    const times = expectNumber(entry.times, MATRIX_SOURCE, `matrix[${index}].times`);
    if (times <= 0) continue;

    const quantity = expectNumber(entry.quantity, MATRIX_SOURCE, `matrix[${index}].quantity`);
    const stageId = expectString(entry.stageId, MATRIX_SOURCE, `matrix[${index}].stageId`);

    const itemEntries = (totals[itemId] ||= []);
    const existing = itemEntries.find(candidate => candidate.stageId === stageId);
    if (existing) {
      existing.quantity += quantity;
      existing.times += times;
    } else {
      itemEntries.push({ stageId, quantity, times });
    }
  }

  const dropMatrix: Record<string, PenguinDropEntry[]> = {};
  let entryCount = 0;
  for (const [itemId, itemEntries] of Object.entries(totals)) {
    dropMatrix[itemId] = itemEntries
      .map(entry => ({
        stageId: entry.stageId,
        expected: Number((entry.quantity / entry.times).toFixed(4)),
        samples: entry.times
      }))
      .sort((a, b) => b.samples - a.samples);
    entryCount += dropMatrix[itemId].length;
  }

  return { dropMatrix, entryCount };
}

/** 由三个接口载荷组装完整输出。 */
export function buildPenguinDropData(
  stageListPayload: unknown,
  matrixPayload: unknown,
  zonePayload: unknown,
  fetchedAt: string
): PenguinDropData {
  const zoneTypes = parseZoneTypes(zonePayload);
  const stages = parseStages(stageListPayload, zoneTypes);
  const { dropMatrix, entryCount } = buildDropMatrix(matrixPayload);

  return {
    metadata: {
      source: 'penguin-stats.io/PenguinStats/api/v2',
      server: SERVER,
      fetchedAt,
      stageCount: Object.keys(stages).length,
      itemCovered: Object.keys(dropMatrix).length,
      matrixEntryCount: entryCount
    },
    stages,
    dropMatrix
  };
}

/** 测试与手工运行可替换的副作用端口。 */
export interface FetchPenguinStatsDeps {
  fetchJson?: (url: string) => Promise<unknown>;
  writeFile?: (filePath: string, data: string) => Promise<void>;
  outputPath?: string;
  now?: () => Date;
}

/** 主函数。 */
export async function main(deps: FetchPenguinStatsDeps = {}): Promise<PenguinDropData> {
  const fetchPayload = deps.fetchJson ?? fetchJson;
  const write = deps.writeFile ?? ((filePath: string, data: string) => writeFile(filePath, data, 'utf-8'));
  const outputPath = deps.outputPath ?? OUTPUT_PATH;

  console.log(`正在从企鹅物流获取 ${SERVER} 服掉落统计数据...`);

  const [stageList, matrixResponse, zoneList] = await Promise.all([
    fetchPayload(`${PENGUIN_API_BASE}/stages?server=${SERVER}`),
    fetchPayload(`${PENGUIN_API_BASE}/result/matrix?server=${SERVER}`),
    fetchPayload(`${PENGUIN_API_BASE}/zones?server=${SERVER}`)
  ]);

  const fetchedAt = (deps.now ?? (() => new Date()))().toISOString();
  const output = buildPenguinDropData(stageList, matrixResponse, zoneList, fetchedAt);

  await write(outputPath, JSON.stringify(output));

  console.log(`✅ 掉落统计数据已保存到: ${outputPath}`);
  console.log(`共 ${output.metadata.stageCount} 个关卡、${output.metadata.itemCovered} 种物品、${output.metadata.matrixEntryCount} 条掉落记录`);

  return output;
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('❌ 获取企鹅物流掉落统计数据失败:', errorMessage(error));
    process.exit(1);
  });
}
