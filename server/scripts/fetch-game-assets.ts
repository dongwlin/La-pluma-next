/**
 * 获取明日方舟游戏资源数据
 * 包括：干员、技能、物品/材料等
 */

import fetch from 'node-fetch';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  errorMessage,
  expectRecord,
  isDirectExecution,
  optionalArray,
  optionalNumber,
  optionalRecord,
  optionalString
} from './scriptSupport.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 游戏数据仓库
const GAME_DATA_BASE = 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata';

// CDN 基础路径
// 注意：官方 CDN 上只有 avatar/ 目录（用户头像），没有干员、技能、物品图片
// 这些图片需要从第三方来源获取，或使用降级方案（首字母、图标等）
const CDN_BASE: string | null = null; // 设置为 null 表示不生成图片 URL

// 输出路径
export const OUTPUT_DIR = path.join(__dirname, '../data');

const CHARACTER_SOURCE = 'character_table.json';
const SKILL_SOURCE = 'skill_table.json';
const ITEM_SOURCE = 'item_table.json';

/** 干员技能条目。 */
export interface CharacterSkill {
  skillId?: string;
  levelUpCostCond: unknown;
}

/** 干员数据。 */
export interface CharacterRecord {
  id: string;
  name: string;
  rarity?: string;
  profession?: string;
  subProfessionId?: string;
  avatar: null;
  portrait: null;
  fullPortrait: null;
  skills: CharacterSkill[];
}

/** 技能等级数据。 */
export interface SkillLevel {
  name?: string;
  description?: string;
  spData: unknown;
  duration?: number;
}

/** 技能数据。 */
export interface SkillRecord {
  id: string;
  name: string;
  icon: string;
  levels: SkillLevel[];
}

/** 物品数据。 */
export interface ItemRecord {
  id: string;
  name?: string;
  description?: string;
  rarity?: string;
  itemType?: string;
  icon: string;
  classifyType?: string;
  obtainApproach?: string;
}

/** 获取游戏数据仓库中的 JSON。 */
async function fetchJson(name: string): Promise<unknown> {
  const response = await fetch(`${GAME_DATA_BASE}/excel/${name}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

/** 解析干员数据。 */
export function parseCharacterData(payload: unknown): Record<string, CharacterRecord> {
  console.log('🔄 正在解析干员数据...');

  const characterTable = expectRecord(payload, CHARACTER_SOURCE);
  const characters: Record<string, CharacterRecord> = {};

  for (const [charId, raw] of Object.entries(characterTable)) {
    const char = expectRecord(raw, CHARACTER_SOURCE, `干员 ${charId}`);
    const name = optionalString(char.name);

    // 跳过非干员数据
    if (!name || charId.startsWith('trap_') || charId.startsWith('token_')) {
      continue;
    }

    const skillEntries = optionalArray(char.skills, CHARACTER_SOURCE, `干员 ${charId} 的 skills`);
    const skills = skillEntries === undefined
      ? []
      : skillEntries.map((skill, index) => {
        const record = expectRecord(skill, CHARACTER_SOURCE, `干员 ${charId} 的 skills[${index}]`);
        return {
          skillId: optionalString(record.skillId),
          levelUpCostCond: record.levelUpCostCond
        };
      });

    characters[charId] = {
      id: charId,
      name,
      rarity: optionalString(char.rarity),
      profession: optionalString(char.profession),
      subProfessionId: optionalString(char.subProfessionId),

      // 图片 URL 设置为 null（官方 CDN 上不存在这些图片）
      // 前端应使用降级方案：首字母、职业图标、渐变色块等
      avatar: null,
      portrait: null,
      fullPortrait: null,

      // 技能列表
      skills
    };
  }

  console.log(`✅ 解析完成，共 ${Object.keys(characters).length} 个干员`);
  return characters;
}

/** 解析技能数据。 */
export function parseSkillData(payload: unknown): Record<string, SkillRecord> {
  console.log('🔄 正在解析技能数据...');

  const skillTable = expectRecord(payload, SKILL_SOURCE);
  const skills: Record<string, SkillRecord> = {};

  for (const [skillId, raw] of Object.entries(skillTable)) {
    const skillRecord = expectRecord(raw, SKILL_SOURCE, `技能 ${skillId}`);
    const levelEntries = optionalArray(skillRecord.levels, SKILL_SOURCE, `技能 ${skillId} 的 levels`);
    const levels = levelEntries === undefined
      ? []
      : levelEntries.map((level, index) => {
        const record = expectRecord(level, SKILL_SOURCE, `技能 ${skillId} 的 levels[${index}]`);
        return {
          name: optionalString(record.name),
          description: optionalString(record.description),
          spData: record.spData,
          duration: optionalNumber(record.duration)
        };
      });

    skills[skillId] = {
      id: skillId,
      name: levels[0]?.name || skillId,

      // 技能图标
      icon: `${CDN_BASE}/skill_icon/${optionalString(skillRecord.iconId) || skillId}.png`,

      // 技能等级数据
      levels
    };
  }

  console.log(`✅ 解析完成，共 ${Object.keys(skills).length} 个技能`);
  return skills;
}

/** 解析物品数据。 */
export function parseItemData(payload: unknown): Record<string, ItemRecord> {
  console.log('🔄 正在解析物品数据...');

  const table = expectRecord(payload, ITEM_SOURCE);
  const itemsData = optionalRecord(table.items, ITEM_SOURCE, 'items') ?? {};
  const items: Record<string, ItemRecord> = {};

  for (const [itemId, raw] of Object.entries(itemsData)) {
    const item = expectRecord(raw, ITEM_SOURCE, `物品 ${itemId}`);

    items[itemId] = {
      id: itemId,
      name: optionalString(item.name),
      description: optionalString(item.description),
      rarity: optionalString(item.rarity),
      itemType: optionalString(item.itemType),

      // 物品图标
      icon: `${CDN_BASE}/item_icon/${optionalString(item.iconId) || itemId}.png`,

      // 分类
      classifyType: optionalString(item.classifyType),

      // 是否可以在商店购买
      obtainApproach: optionalString(item.obtainApproach)
    };
  }

  console.log(`✅ 解析完成，共 ${Object.keys(items).length} 个物品`);
  return items;
}

/** 保存数据到文件。 */
export async function saveData(
  filename: string,
  data: Record<string, { name?: string; id?: string }>,
  deps: SaveDataDeps = {}
): Promise<void> {
  const outputDir = deps.outputDir ?? OUTPUT_DIR;
  const filepath = path.join(outputDir, filename);
  const ensureDir = deps.mkdir ?? ((directory: string) => mkdir(directory, { recursive: true }));
  const write = deps.writeFile ?? ((filePath: string, content: string) => writeFile(filePath, content, 'utf-8'));

  try {
    await ensureDir(outputDir);
    await write(filepath, JSON.stringify(data, null, 2));
    console.log(`✅ 数据已保存到: ${filepath}`);
    console.log(`📊 总计 ${Object.keys(data).length} 条记录`);
  } catch (error) {
    console.error(`❌ 保存数据失败:`, errorMessage(error));
    throw error;
  }
}

/** 保存数据的副作用端口。 */
export interface SaveDataDeps {
  mkdir?: (directory: string) => Promise<void>;
  writeFile?: (filePath: string, data: string) => Promise<void>;
  outputDir?: string;
}

/** 显示示例数据。 */
function showExamples(data: Record<string, { name?: string; id?: string }>, count = 5): void {
  const examples = Object.keys(data).slice(0, count);
  console.log('\n示例数据:');
  examples.forEach(key => {
    const item = data[key];
    console.log(`  ${key}: ${item.name || item.id}`);
  });
}

/** 抓取与主流程的副作用端口。 */
export interface FetchGameAssetsDeps extends SaveDataDeps {
  fetchJson?: (name: string) => Promise<unknown>;
}

/** 主函数。 */
export async function main(deps: FetchGameAssetsDeps = {}): Promise<{
  characters: Record<string, CharacterRecord>;
  skills: Record<string, SkillRecord>;
  items: Record<string, ItemRecord>;
}> {
  const fetchPayload = deps.fetchJson ?? fetchJson;

  console.log('========================================');
  console.log('   明日方舟游戏资源数据获取工具');
  console.log('========================================\n');

  // 1. 获取干员数据
  console.log('【1/3】处理干员数据');
  console.log('─────────────────────────────────────');
  const characterTable = await fetchPayload('character_table.json');
  const characters = parseCharacterData(characterTable);
  await saveData('characters.json', characters, deps);
  showExamples(characters);

  console.log('\n');

  // 2. 获取技能数据
  console.log('【2/3】处理技能数据');
  console.log('─────────────────────────────────────');
  const skillTable = await fetchPayload('skill_table.json');
  const skills = parseSkillData(skillTable);
  await saveData('skills.json', skills, deps);
  showExamples(skills);

  console.log('\n');

  // 3. 获取物品数据
  console.log('【3/3】处理物品数据');
  console.log('─────────────────────────────────────');
  const itemTable = await fetchPayload('item_table.json');
  const items = parseItemData(itemTable);
  await saveData('items.json', items, deps);
  showExamples(items);

  console.log('\n========================================');
  console.log('   ✅ 所有任务完成！');
  console.log('========================================');
  console.log('\n生成的文件:');
  console.log(`  - characters.json (${Object.keys(characters).length} 个干员)`);
  console.log(`  - skills.json (${Object.keys(skills).length} 个技能)`);
  console.log(`  - items.json (${Object.keys(items).length} 个物品)`);

  return { characters, skills, items };
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('\n❌ 执行失败:', errorMessage(error));
    process.exit(1);
  });
}
