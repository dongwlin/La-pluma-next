import fetch from 'node-fetch';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  errorMessage,
  expectRecord,
  isDirectExecution,
  optionalRecord,
  optionalString
} from './scriptSupport.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '../data');
const BASE = 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel';

const HANDBOOK_SOURCE = 'handbook_info_table.json';
const CHARACTER_SOURCE = 'character_table.json';

/** 悖论模拟干员条目。 */
export interface ParadoxOperator {
  id: string;
  name: string;
  stage_id: string;
  stage_name: string;
}

/** 输出目标：paradox-operators.json。 */
export const OUTPUT_PATH = join(OUTPUT_DIR, 'paradox-operators.json');

/** 从 handbook_info_table.json 与 character_table.json 解析悖论模拟干员。 */
export function parseParadoxOperators(handbookPayload: unknown, characterPayload: unknown): ParadoxOperator[] {
  const handbook = expectRecord(handbookPayload, HANDBOOK_SOURCE);
  const characters = expectRecord(characterPayload, CHARACTER_SOURCE);
  const stageData = optionalRecord(handbook.handbookStageData, HANDBOOK_SOURCE, 'handbookStageData') ?? {};
  const handbookDict = optionalRecord(handbook.handbookDict, HANDBOOK_SOURCE, 'handbookDict') ?? {};

  const operators: ParadoxOperator[] = [];

  for (const [charId, raw] of Object.entries(stageData)) {
    const stage = expectRecord(raw, HANDBOOK_SOURCE, `handbookStageData.${charId}`);
    const stageId = optionalString(stage.stageId) || optionalString(stage.code);
    if (!stageId) continue;

    const characterValue = characters[charId];
    const character = characterValue === undefined
      ? undefined
      : expectRecord(characterValue, CHARACTER_SOURCE, `干员 ${charId}`);
    const dictValue = handbookDict[charId];
    const dictEntry = dictValue === undefined
      ? undefined
      : expectRecord(dictValue, HANDBOOK_SOURCE, `handbookDict.${charId}`);

    operators.push({
      id: charId,
      name: optionalString(character?.name) || optionalString(dictEntry?.infoName) || charId,
      stage_id: stageId,
      stage_name: optionalString(stage.name) || ''
    });
  }

  return operators.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/** 从游戏数据仓库获取 JSON。 */
async function fetchJson(name: string): Promise<unknown> {
  const response = await fetch(`${BASE}/${name}`);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response.json();
}

/** 测试与手工运行可替换的副作用端口。 */
export interface FetchParadoxOperatorsDeps {
  fetchJson?: (name: string) => Promise<unknown>;
  mkdir?: (directory: string) => Promise<void>;
  writeFile?: (filePath: string, data: string) => Promise<void>;
  outputDir?: string;
  outputPath?: string;
}

/** 主函数。 */
export async function main(deps: FetchParadoxOperatorsDeps = {}): Promise<ParadoxOperator[]> {
  const fetchPayload = deps.fetchJson ?? fetchJson;
  const ensureDir = deps.mkdir ?? ((directory: string) => mkdir(directory, { recursive: true }));
  const write = deps.writeFile ?? ((filePath: string, data: string) => writeFile(filePath, data, 'utf-8'));
  const outputDir = deps.outputDir ?? OUTPUT_DIR;
  const outputPath = deps.outputPath ?? OUTPUT_PATH;

  const [handbook, characters] = await Promise.all([
    fetchPayload('handbook_info_table.json'),
    fetchPayload('character_table.json')
  ]);

  const operators = parseParadoxOperators(handbook, characters);

  await ensureDir(outputDir);
  await write(outputPath, JSON.stringify(operators, null, 2));
  console.log(`✅ 悖论模拟干员数据已保存: ${outputPath} (${operators.length} 个)`);

  return operators;
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('❌ 获取悖论模拟干员数据失败:', errorMessage(error));
    process.exit(1);
  });
}
