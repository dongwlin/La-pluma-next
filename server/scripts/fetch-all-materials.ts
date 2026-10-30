import { readFile, writeFile } from 'node:fs/promises';
import {
  errorMessage,
  expectRecord,
  invalidPayload,
  isDirectExecution,
  optionalArray,
  optionalRecord,
  resolveTrainingDataPath,
  type JsonRecord
} from './scriptSupport.ts';

const ITEM_TABLE_URL = 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/item_table.json';
const ITEM_SOURCE = 'item_table.json';
const MATERIALS_SOURCE = 'materials.json';

/** 材料数据文件路径。 */
export const MATERIALS_PATH = resolveTrainingDataPath('materials.json');

/** 单个推荐关卡。 */
export interface MaterialStage {
  stage: string;
  efficiency: number;
  dropRate: number | null;
}

/** 单个材料条目。 */
export interface MaterialEntry {
  id: string;
  name: string;
  rarity: number;
  bestStages?: MaterialStage[];
}

/** materials.json 中本脚本维护的结构。 */
export interface MaterialsDatabase {
  materials: Record<string, MaterialEntry>;
  recipes: JsonRecord;
  stageSchedule: JsonRecord;
}

/** occPer 是万分比；无法解析为数字时写入 null（与原输出一致）。 */
function toDropRate(occPer: unknown): number | null {
  const value = typeof occPer === 'number'
    ? occPer
    : typeof occPer === 'string'
      ? Number(occPer)
      : Number.NaN;
  if (!Number.isFinite(value)) return null;
  return Number.parseFloat((value / 10000).toFixed(4));
}

/** 解析最多 3 个推荐关卡。 */
function readBestStages(value: unknown, itemId: string): MaterialStage[] {
  const drops = optionalArray(value, ITEM_SOURCE, `物品 ${itemId} 的 stageDropList`);
  if (drops === undefined) return [];
  const bestStages: MaterialStage[] = [];

  for (const [index, raw] of drops.slice(0, 3).entries()) {
    const drop = expectRecord(raw, ITEM_SOURCE, `物品 ${itemId} 的 stageDropList[${index}]`);
    if (typeof drop.stageId !== 'string' || !drop.stageId) continue;
    if (!drop.occPer) continue;
    bestStages.push({
      stage: drop.stageId,
      efficiency: 1.0,
      dropRate: toDropRate(drop.occPer)
    });
  }

  return bestStages;
}

/** 从 item_table.json 提取材料信息（只处理材料类型）。 */
export function parseMaterials(payload: unknown): Record<string, MaterialEntry> {
  const table = expectRecord(payload, ITEM_SOURCE);
  const items = optionalRecord(table.items, ITEM_SOURCE, 'items') ?? {};
  const materials: Record<string, MaterialEntry> = {};

  for (const [itemId, raw] of Object.entries(items)) {
    const item = expectRecord(raw, ITEM_SOURCE, `物品 ${itemId}`);

    // 只处理材料类型（itemType === 'MATERIAL'）
    if (item.itemType !== 'MATERIAL' || item.classifyType !== 'MATERIAL') continue;

    const name = typeof item.name === 'string' ? item.name : undefined;
    if (name === undefined) throw invalidPayload(ITEM_SOURCE, `物品 ${itemId} 缺少名称`);

    const bestStages = readBestStages(item.stageDropList, itemId);
    materials[itemId] = {
      id: itemId,
      name,
      rarity: Number.parseInt(String(item.rarity), 10) || 0,
      ...(bestStages.length > 0 ? { bestStages } : {})
    };
  }

  return materials;
}

/** 合并材料信息，保留已有的 recipes 与 stageSchedule。 */
export function buildMaterialsDatabase(materials: Record<string, MaterialEntry>, existingPayload: unknown): MaterialsDatabase {
  const existing = existingPayload === undefined
    ? {}
    : expectRecord(existingPayload, MATERIALS_SOURCE);
  const recipes = optionalRecord(existing.recipes, MATERIALS_SOURCE, 'recipes') ?? {};
  const stageSchedule = optionalRecord(existing.stageSchedule, MATERIALS_SOURCE, 'stageSchedule') ?? {};

  return { materials, recipes, stageSchedule };
}

/** 从 URL 获取 JSON 数据。 */
async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/** 测试与手工运行可替换的副作用端口。 */
export interface FetchAllMaterialsDeps {
  fetchJson?: (url: string) => Promise<unknown>;
  readFile?: (filePath: string) => Promise<string>;
  writeFile?: (filePath: string, data: string) => Promise<void>;
  materialsPath?: string;
}

/** 主函数。 */
export async function main(deps: FetchAllMaterialsDeps = {}): Promise<MaterialsDatabase> {
  const fetchPayload = deps.fetchJson ?? fetchJson;
  const read = deps.readFile ?? ((filePath: string) => readFile(filePath, 'utf-8'));
  const write = deps.writeFile ?? ((filePath: string, data: string) => writeFile(filePath, data, 'utf-8'));
  const materialsPath = deps.materialsPath ?? MATERIALS_PATH;

  console.log('正在获取 item_table.json...');

  const itemData = await fetchPayload(ITEM_TABLE_URL);
  const itemTable = expectRecord(itemData, ITEM_SOURCE);
  const items = optionalRecord(itemTable.items, ITEM_SOURCE, 'items') ?? {};

  console.log(`找到 ${Object.keys(items).length} 个物品\n`);

  const materials = parseMaterials(itemData);

  for (const [index, [itemId, material]] of Object.entries(materials).entries()) {
    if (index >= 10) break;
    console.log(`  ${itemId} (${material.name}) [稀有度${material.rarity}] - ${material.bestStages?.length || 0} 个关卡`);
  }

  console.log(`\n提取了 ${Object.keys(materials).length} 个材料`);

  // 读取现有的 materials.json；文件缺失或无法解析时使用空结构
  let existingData: unknown;
  try {
    existingData = JSON.parse(await read(materialsPath));
  } catch {
    existingData = undefined;
  }

  const newData = buildMaterialsDatabase(materials, existingData);

  // 保存到文件
  await write(materialsPath, JSON.stringify(newData, null, 2));

  console.log(`✅ 材料信息已保存到: ${materialsPath}`);
  console.log(`总共 ${Object.keys(newData.materials).length} 个材料`);

  // 特别检查异铁
  const iron = newData.materials['30042'];
  if (iron) {
    console.log('\n✅ 找到异铁 (30042):');
    console.log(`  名称: ${iron.name}`);
    console.log(`  稀有度: ${iron.rarity}`);
    console.log(`  关卡数: ${iron.bestStages?.length || 0}`);
  }

  return newData;
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('❌ 获取材料信息失败:', errorMessage(error));
    process.exit(1);
  });
}
