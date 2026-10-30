/**
 * 从 Kengxxiao/ArknightsGameData 获取干员材料数据
 * 自动生成 operator-materials.json
 */

import https from 'node:https';
import { writeFile } from 'node:fs/promises';
import {
  errorMessage,
  expectNumber,
  expectRecord,
  expectString,
  invalidPayload,
  isDirectExecution,
  optionalArray,
  optionalString,
  resolveTrainingDataPath
} from './scriptSupport.ts';

const GAMEDATA_URL = 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/character_table.json';
const ITEM_TABLE_URL = 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/item_table.json';
const CHARACTER_SOURCE = 'character_table.json';
const ITEM_SOURCE = 'item_table.json';

/** 输出目标：与其他养成数据文件一致，写入训练数据目录。 */
export const OUTPUT_PATH = resolveTrainingDataPath('operator-materials.json');

/** 单条精英化消耗。 */
interface EvolveCost {
  id: string;
  count: number;
}

/** 干员精英化阶段中本脚本读取的字段。 */
interface CharacterPhase {
  evolveCost?: EvolveCost[];
}

/** character_table.json 中本脚本读取的干员字段。 */
interface CharacterEntry {
  name?: string;
  rarity?: string | number;
  profession?: string;
  phases?: CharacterPhase[];
  isNotObtainable: boolean;
}

/** item_table.json 中的物品名称映射。 */
type ItemNames = Record<string, string | undefined>;

/** 干员材料条目。 */
export interface MaterialCost {
  id: string;
  name: string;
  count: number;
}

/** 精英 1 材料需求。 */
export interface EliteMaterials {
  lmd: number;
  materials: MaterialCost[];
}

/** 精英 2 材料需求，芯片单独分组。 */
export interface Elite2Materials extends EliteMaterials {
  chips: MaterialCost[];
}

/** 单个干员的材料数据。 */
export interface OperatorMaterialEntry {
  id: string;
  name: string;
  rarity: number;
  profession?: string;
  elite1?: EliteMaterials;
  elite2?: Elite2Materials;
}

/** operator-materials.json 的完整结构。 */
export interface OperatorMaterialsOutput {
  operators: Record<string, OperatorMaterialEntry>;
  metadata: {
    version: string;
    lastUpdated: string;
    totalOperators: number;
    source: string;
    notes: string;
  };
}

/** 职业映射。 */
const professionMap: Record<string, string> = {
  'PIONEER': '先锋',
  'WARRIOR': '近卫',
  'SNIPER': '狙击',
  'TANK': '重装',
  'MEDIC': '医疗',
  'SUPPORT': '辅助',
  'CASTER': '术师',
  'SPECIAL': '特种'
};

/** 从 URL 获取 JSON 数据。 */
function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    https.get(url, (response) => {
      let data = '';

      response.on('data', (chunk) => {
        data += chunk;
      });

      response.on('end', () => {
        try {
          resolvePromise(JSON.parse(data));
        } catch (error) {
          rejectPromise(error);
        }
      });
    }).on('error', rejectPromise);
  });
}

/** 解析单条精英化消耗。 */
function readEvolveCost(value: unknown, charId: string, phaseIndex: number, costIndex: number): EvolveCost {
  const label = `干员 ${charId} 的 phases[${phaseIndex}].evolveCost[${costIndex}]`;
  const cost = expectRecord(value, CHARACTER_SOURCE, label);
  const id = expectString(cost.id, CHARACTER_SOURCE, `${label}.id`);
  const count = expectNumber(cost.count, CHARACTER_SOURCE, `${label}.count`);
  return { id, count };
}

/** 解析单个精英化阶段。 */
function readPhase(value: unknown, charId: string, index: number): CharacterPhase {
  const phase = expectRecord(value, CHARACTER_SOURCE, `干员 ${charId} 的 phases[${index}]`);
  const evolveCosts = optionalArray(phase.evolveCost, CHARACTER_SOURCE, `干员 ${charId} 的 phases[${index}].evolveCost`);
  if (!evolveCosts) return {};
  return {
    evolveCost: evolveCosts.map((cost, costIndex) => readEvolveCost(cost, charId, index, costIndex))
  };
}

/** 解析单个干员条目，未使用的字段不入对象。 */
function readCharacterEntry(value: unknown, charId: string): CharacterEntry {
  const entry = expectRecord(value, CHARACTER_SOURCE, `干员 ${charId}`);
  const phases = optionalArray(entry.phases, CHARACTER_SOURCE, `干员 ${charId} 的 phases`)
    ?.map((phase, index) => readPhase(phase, charId, index));
  const rarity = typeof entry.rarity === 'string' || typeof entry.rarity === 'number' ? entry.rarity : undefined;
  return {
    name: optionalString(entry.name),
    rarity,
    profession: optionalString(entry.profession),
    phases,
    isNotObtainable: entry.isNotObtainable === true
  };
}

/** 解析 item_table.json 中的物品名称。 */
function readItemNames(payload: unknown): ItemNames {
  const table = expectRecord(payload, ITEM_SOURCE);
  const items = expectRecord(table.items, ITEM_SOURCE, 'items');
  const names: ItemNames = {};
  for (const [itemId, value] of Object.entries(items)) {
    const item = expectRecord(value, ITEM_SOURCE, `物品 ${itemId}`);
    names[itemId] = optionalString(item.name);
  }
  return names;
}

/** 解析稀有度：TIER_1 = 1星，数字 0 起算。 */
function readRarity(rarity: CharacterEntry['rarity']): number {
  if (typeof rarity === 'string' && rarity.startsWith('TIER_')) {
    return Number.parseInt(rarity.replace('TIER_', ''), 10);
  }
  if (typeof rarity === 'number') return rarity + 1;
  return 0;
}

/** 组装单条材料消耗。 */
function toMaterialCost(cost: EvolveCost, itemNames: ItemNames): MaterialCost {
  return {
    id: cost.id,
    name: itemNames[cost.id] || cost.id,
    count: cost.count
  };
}

/** 解析干员材料数据。 */
export function parseOperatorMaterials(characterPayload: unknown, itemPayload: unknown): Record<string, OperatorMaterialEntry> {
  const characterTable = expectRecord(characterPayload, CHARACTER_SOURCE);
  const itemNames = readItemNames(itemPayload);
  const operators: Record<string, OperatorMaterialEntry> = {};

  for (const [charId, value] of Object.entries(characterTable)) {
    const charInfo = readCharacterEntry(value, charId);

    // 只处理可招募的干员（排除敌人、NPC等）
    if (!charInfo.phases || charInfo.phases.length === 0) continue;
    if (charInfo.isNotObtainable) continue;

    const rarity = readRarity(charInfo.rarity);

    // 只处理 4 星及以上
    if (rarity < 4) continue;

    if (charInfo.name === undefined) {
      throw invalidPayload(CHARACTER_SOURCE, `干员 ${charId} 缺少名称`);
    }

    const operator: OperatorMaterialEntry = {
      id: charId,
      name: charInfo.name,
      rarity,
      profession: professionMap[charInfo.profession ?? ''] || charInfo.profession
    };

    // 解析精英化材料
    if (charInfo.phases.length >= 2) {
      const phase1 = charInfo.phases[1];
      if (phase1.evolveCost) {
        operator.elite1 = {
          lmd: phase1.evolveCost.find(cost => cost.id === '4001')?.count || 0,
          materials: phase1.evolveCost
            .filter(cost => cost.id !== '4001')
            .map(cost => toMaterialCost(cost, itemNames))
        };
      }
    }

    if (charInfo.phases.length >= 3) {
      const phase2 = charInfo.phases[2];
      if (phase2.evolveCost) {
        const materials: MaterialCost[] = [];
        const chips: MaterialCost[] = [];

        for (const cost of phase2.evolveCost) {
          if (cost.id === '4001') continue; // 跳过龙门币

          const item = toMaterialCost(cost, itemNames);

          // 芯片组单独分类
          if (cost.id.startsWith('32')) {
            chips.push(item);
          } else {
            materials.push(item);
          }
        }

        operator.elite2 = {
          lmd: phase2.evolveCost.find(cost => cost.id === '4001')?.count || 0,
          materials,
          chips
        };
      }
    }

    // 只保存有精英化数据的干员
    if (operator.elite1 || operator.elite2) {
      operators[charId] = operator;
    }
  }

  return operators;
}

/** 组装输出文件内容。 */
export function buildOperatorMaterialsOutput(
  operators: Record<string, OperatorMaterialEntry>,
  lastUpdated: string
): OperatorMaterialsOutput {
  return {
    operators,
    metadata: {
      version: '2.0.0',
      lastUpdated,
      totalOperators: Object.keys(operators).length,
      source: 'Kengxxiao/ArknightsGameData',
      notes: '自动从游戏数据生成，包含所有 4 星及以上可招募干员的精英化材料'
    }
  };
}

/** 测试与手工运行可替换的副作用端口。 */
export interface FetchOperatorMaterialsDeps {
  fetchJson?: (url: string) => Promise<unknown>;
  writeFile?: (filePath: string, data: string) => Promise<void>;
  outputPath?: string;
  now?: () => Date;
}

/** 主函数。 */
export async function main(deps: FetchOperatorMaterialsDeps = {}): Promise<OperatorMaterialsOutput> {
  const fetchPayload = deps.fetchJson ?? fetchJson;
  const write = deps.writeFile ?? ((filePath: string, data: string) => writeFile(filePath, data, 'utf-8'));
  const outputPath = deps.outputPath ?? OUTPUT_PATH;

  console.log('正在获取干员数据...');
  const characterData = await fetchPayload(GAMEDATA_URL);

  console.log('正在获取物品数据...');
  const itemTable = await fetchPayload(ITEM_TABLE_URL);

  console.log('正在解析材料数据...');
  const operators = parseOperatorMaterials(characterData, itemTable);

  const lastUpdated = (deps.now ?? (() => new Date()))().toISOString().split('T')[0];
  const output = buildOperatorMaterialsOutput(operators, lastUpdated);

  console.log(`共解析 ${output.metadata.totalOperators} 个干员`);

  console.log('正在保存到文件...');
  await write(outputPath, JSON.stringify(output, null, 2));

  console.log(`✓ 成功！数据已保存到: ${outputPath}`);
  console.log(`\n统计信息:`);

  // 统计各稀有度数量
  const rarityCount: Record<number, number> = {};
  for (const op of Object.values(operators)) {
    rarityCount[op.rarity] = (rarityCount[op.rarity] || 0) + 1;
  }

  console.log(`  6星: ${rarityCount[6] || 0} 个`);
  console.log(`  5星: ${rarityCount[5] || 0} 个`);
  console.log(`  4星: ${rarityCount[4] || 0} 个`);

  return output;
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('错误:', errorMessage(error));
    process.exit(1);
  });
}
