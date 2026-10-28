import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  errorMessage,
  expectRecord,
  isDirectExecution,
  optionalArray,
  optionalRecord,
  optionalString
} from './scriptSupport.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BUILDING_URL = 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/building_data.json';
const ITEM_TABLE_URL = 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/item_table.json';
const BUILDING_SOURCE = 'building_data.json';
const ITEM_SOURCE = 'item_table.json';

/** 输出目标：material-formulas.json。 */
export const OUTPUT_PATH = join(__dirname, '../data/material-formulas.json');

/** 配方消耗项。 */
interface FormulaCost {
  id?: string;
  count?: number;
}

/** 配方详情中本脚本读取的字段。 */
interface FormulaDetail {
  costs?: FormulaCost[];
}

/** item_table.json 中的产物信息。 */
interface ProductEntry {
  roomType?: string;
  formulaId?: string;
}

interface ItemEntry {
  name?: string;
  buildingProductList?: ProductEntry[];
}

/** 单个材料合成配方。 */
export interface MaterialFormula {
  id: string;
  name?: string;
  type: 'craft' | 'manufacture';
  materials: Record<string, number>;
}

/** material-formulas.json 的完整结构：物品 Id 到配方。 */
export type MaterialFormulaTable = Record<string, MaterialFormula>;

/** 解析 building_data.json 中的配方表。 */
function readFormulaTable(value: unknown, label: string): Record<string, FormulaDetail> {
  const table = optionalRecord(value, BUILDING_SOURCE, label) ?? {};
  const formulas: Record<string, FormulaDetail> = {};
  for (const [formulaId, raw] of Object.entries(table)) {
    const formula = expectRecord(raw, BUILDING_SOURCE, `${label}.${formulaId}`);
    const costEntries = optionalArray(formula.costs, BUILDING_SOURCE, `${label}.${formulaId}.costs`);
    const costs = costEntries === undefined
      ? []
      : costEntries.map((cost, index) => {
        const record = expectRecord(cost, BUILDING_SOURCE, `${label}.${formulaId}.costs[${index}]`);
        return {
          id: optionalString(record.id),
          count: typeof record.count === 'number' ? record.count : undefined
        };
      });
    formulas[formulaId] = { costs };
  }
  return formulas;
}

/** 解析 item_table.json 中本脚本读取的物品字段。 */
function readItems(payload: unknown): Record<string, ItemEntry> {
  const table = expectRecord(payload, ITEM_SOURCE);
  const items = optionalRecord(table.items, ITEM_SOURCE, 'items') ?? {};
  const result: Record<string, ItemEntry> = {};
  for (const [itemId, raw] of Object.entries(items)) {
    const item = expectRecord(raw, ITEM_SOURCE, `物品 ${itemId}`);
    const products = optionalArray(item.buildingProductList, ITEM_SOURCE, `物品 ${itemId} 的 buildingProductList`);
    const buildingProductList = products?.map((product, index) => {
      const record = expectRecord(product, ITEM_SOURCE, `物品 ${itemId} 的 buildingProductList[${index}]`);
      return {
        roomType: optionalString(record.roomType),
        formulaId: optionalString(record.formulaId)
      };
    });
    result[itemId] = {
      name: optionalString(item.name),
      buildingProductList
    };
  }
  return result;
}

/**
 * 从 building_data.json 与 item_table.json 提取材料合成配方。
 * 只保留第一段 buildingProductList 且能匹配到配方消耗的物品。
 */
export function extractMaterialFormulas(buildingPayload: unknown, itemPayload: unknown): MaterialFormulaTable {
  const building = expectRecord(buildingPayload, BUILDING_SOURCE);
  const workshopFormulas = readFormulaTable(building.workshopFormulas, 'workshopFormulas');
  const manufactFormulas = readFormulaTable(building.manufactFormulas, 'manufactFormulas');

  // 建立 formulaId -> 配方详情 的映射
  const formulaMap = new Map<string, FormulaDetail>();
  for (const [formulaId, formula] of Object.entries(workshopFormulas)) {
    formulaMap.set(`WORKSHOP_${formulaId}`, formula);
  }
  for (const [formulaId, formula] of Object.entries(manufactFormulas)) {
    formulaMap.set(`MANUFACTURE_${formulaId}`, formula);
  }

  const items = readItems(itemPayload);
  const recipes: MaterialFormulaTable = {};

  for (const [itemId, item] of Object.entries(items)) {
    // 取第一个配方
    const productInfo = item.buildingProductList?.[0];
    if (!productInfo?.roomType || !productInfo.formulaId) continue;

    const formula = formulaMap.get(`${productInfo.roomType}_${productInfo.formulaId}`);
    if (!formula?.costs || formula.costs.length === 0) continue;

    const materials: Record<string, number> = {};
    for (const cost of formula.costs) {
      if (cost.id && cost.count) {
        materials[cost.id] = cost.count;
      }
    }

    if (Object.keys(materials).length === 0) continue;

    recipes[itemId] = {
      id: itemId,
      name: item.name,
      type: productInfo.roomType === 'WORKSHOP' ? 'craft' : 'manufacture',
      materials
    };
  }

  return recipes;
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
export interface FetchMaterialFormulasDeps {
  fetchJson?: (url: string) => Promise<unknown>;
  writeFile?: (filePath: string, data: string) => Promise<void>;
  outputPath?: string;
}

/** 主函数。 */
export async function main(deps: FetchMaterialFormulasDeps = {}): Promise<MaterialFormulaTable> {
  const fetchPayload = deps.fetchJson ?? fetchJson;
  const write = deps.writeFile ?? ((filePath: string, data: string) => writeFile(filePath, data, 'utf-8'));
  const outputPath = deps.outputPath ?? OUTPUT_PATH;

  console.log('正在获取 building_data.json...');

  const buildingData = await fetchPayload(BUILDING_URL);
  const building = expectRecord(buildingData, BUILDING_SOURCE);
  const workshopFormulas = optionalRecord(building.workshopFormulas, BUILDING_SOURCE, 'workshopFormulas') ?? {};
  const manufactFormulas = optionalRecord(building.manufactFormulas, BUILDING_SOURCE, 'manufactFormulas') ?? {};

  console.log(`找到 ${Object.keys(workshopFormulas).length} 个工坊配方`);
  console.log(`找到 ${Object.keys(manufactFormulas).length} 个制造站配方`);

  console.log('\n正在获取 item_table.json...');

  const itemData = await fetchPayload(ITEM_TABLE_URL);
  const itemTable = expectRecord(itemData, ITEM_SOURCE);
  const items = optionalRecord(itemTable.items, ITEM_SOURCE, 'items') ?? {};

  console.log(`找到 ${Object.keys(items).length} 个物品\n`);

  const recipes = extractMaterialFormulas(buildingData, itemData);

  console.log(`\n提取了 ${Object.keys(recipes).length} 个合成配方`);

  // 保存到文件
  await write(outputPath, JSON.stringify(recipes, null, 2));

  console.log(`✅ 材料合成配方已保存到: ${outputPath}`);

  // 特别检查 D32钢
  const d32 = recipes['30135'];
  if (d32) {
    console.log('\n✅ 找到 D32钢 (30135) 的合成配方:');
    console.log(`  名称: ${d32.name}`);
    console.log(`  材料: ${JSON.stringify(d32.materials)}`);
  } else {
    console.log('\n⚠️  未找到 D32钢 (30135) 的合成配方');
  }

  return recipes;
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('❌ 获取材料合成配方失败:', errorMessage(error));
    process.exit(1);
  });
}
